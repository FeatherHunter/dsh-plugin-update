/**
 * selftest/real-machine/scenarios/d-desktop-manager-exits.ts —— 出口二：官方桌面 in-process 插件管理器。
 *
 * 矩阵格（场景声明单源：identity/scenario-declarations.ts）：
 *   d1-desktop-manager-update-success  —— 已装 0.0.1 更新到 0.0.2：宿主 already-installed 守卫 →
 *                                         removeBundle → installBundle 两步配方；operation 日志窗口内恰两次 pnpm。
 *   d2-desktop-manager-update-failure  —— 检查更新之后只把 0.0.2 的 tarball 从 registry storage 删掉
 *                                         （元数据与 integrity 一字不改）：候选门能过、移除步成功，
 *                                         pnpm 重装下载 tarball 时 404 非零退出 → 产品给人话格「目标包已被宿主移除，
 *                                         重装失败」+ 可执行载体命令；磁盘不许出现 0.0.2（无虚假成功）。
 *   can-red（复用 d1 声明）            —— 发布 0.0.2 但内容仍是 0.0.1（stale-variant），预期重启后
 *                                         「新版 UI / 可见变化」断言真红，用来证明该断言不是永真。
 *
 * 证据纪律：每个断言 actual 都来自本 run 的原始观测（DOM 快照 / operation 日志原文 / 产品日志 /
 * state.json / 磁盘）；读日志前先停桌面（日志缓冲要靠进程收尾冲刷）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunManifest } from '../runtime/evidence.ts'
import { capturePluginManagerOperations } from '../runtime/evidence.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp } from '../host/desktop-app.ts'
import { waitForProfileDir } from '../host/isolated-profile.ts'
import { readProfileManifest, runDshCli } from '../host/dsh-cli.ts'
import type { LogEventRecord } from '../runtime/log-evidence.ts'
import { captureLogFiles, eventsOf } from '../runtime/log-evidence.ts'
import type { ScenarioFaultInjection } from '../runtime/scenario-runner.ts'
import { publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import type { FixtureVariantEffect } from '../../fixtures/identity/fixture-slots.ts'
import { legacySingleEffectOf } from '../../fixtures/identity/scenario-declarations.ts'
import { fixtureSpecOf } from '../runtime/fixture-environment.ts'
import { removePublishedTarball, restorePublishedTarball, warmRegistryTarball } from '../runtime/registry-faults.ts'
import { listFilesRecursive, sha256File } from '../../tooling/fs-utils.ts'
import { waitFor } from '../../tooling/process.ts'
import type { PanelState } from './a-single-package-main-chain.ts'
import { captureShot, clickPanelAction, readPanelState, waitForFixtureLoaded } from './a-single-package-main-chain.ts'
import type { T3Run } from './t3-common.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'

/** 出口二的三格：成功 / 失败（移除后重装失败）/ can-red（stale-variant）。 */
export type DesktopManagerExitMode = 'success' | 'failure' | 'can-red'

/** 场景入参。 */
export interface DesktopManagerExitsOptions {
  readonly worktree: string
  /** run 根目录（仓库外，例 D:/dsh-plugin/_wt263/runtime/t3-267）。 */
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  /** 维护者 DSH_HOME（只读指纹）。 */
  readonly maintainerHome?: string
  readonly mode: DesktopManagerExitMode
}

/** 台账里的一条任务状态（<home>/updates/<pluginId>/<范围短指纹>/state.json）。 */
interface LedgerState {
  readonly file: string
  readonly state: Record<string, unknown>
}

/** 递归读 <home>/updates/<pluginId>/<范围短指纹>/state.json（只读；原文由调用方落 raw）。 */
async function readLedgerStates(homeDir: string): Promise<LedgerState[]> {
  const root = join(homeDir, 'updates')
  let files: string[] = []
  try {
    files = await listFilesRecursive(root)
  } catch (error) {
    return []
  }
  const records: LedgerState[] = []
  for (const relative of files) {
    if (relative.split('/').pop() !== 'state.json') continue
    const file = join(root, relative.split('/').join('\\'))
    try {
      records.push({ file, state: JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> })
    } catch (error) {
      records.push({ file, state: { corrupt: true } })
    }
  }
  return records
}

/** 从人话格 detail 里取可执行命令（产品载体命令写在括号里：…（dsh plugin …））。 */
function executableCommandOf(text: string): string | null {
  const match = /\((dsh plugin [^)]+)\)/.exec(text)
  return match ? match[1] : null
}

/** 把面板/人话格给出的命令原文切成 runDshCli 的 argv（去掉开头的 dsh，保留 plugin 子命令；命令里没有引号与空格参数）。 */
function argvOfCommand(text: string): string[] | null {
  const tokens = text.trim().split(/\s+/)
  if (tokens.length < 4 || tokens[0] !== 'dsh' || tokens[1] !== 'plugin') return null
  return tokens.slice(1)
}

/** 跑一个出口二矩阵格。 */
export async function runDesktopManagerExits(options: DesktopManagerExitsOptions): Promise<RunManifest> {
  const mode = options.mode
  const fault: ScenarioFaultInjection | undefined =
    mode === 'can-red'
      ? {
          kind: 'stale-variant',
          slotKey: 'a',
          description: 'can-red：发布 0.0.2 但构建内容仍是 0.0.1（client/host 构建标记不变），预期重启后「新版 UI」断言真红',
        }
      : undefined
  const run: T3Run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId: mode === 'failure' ? 'd2-desktop-manager-update-failure' : 'd1-desktop-manager-update-success',
    hostChannel: 'desktop-official',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
  })
  const fixtureEnv = run.fixtureEnv
  if (!fixtureEnv) throw new Error('[d] 场景缺少夹具环境')
  const registry = fixtureEnv.registry
  const registryUrl = registry.baseUrl
  const profileName = 'desktop'
  const homeDir = run.layout.homeDir
  const userDataDir = run.layout.userDataDir
  const launch = (): Promise<DesktopSession> => launchDesktopApp({ homeDir, userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registryUrl } })
  let session: DesktopSession | null = null

  try {
    if (fault) {
      run.addNote('can-red 故障注入：' + fault.kind + '（' + fault.description + '）；本 run 预期整体 fail，用来证明「重启后新版 UI」断言可红')
    }

    // ---- 0. 首启桌面：让官方桌面自己建 <home>/profiles/desktop ----
    session = await launch()
    const bootstrapPid = session.process.pid() ?? null
    await waitForProfileDir({ homeDir, profileName, timeoutMs: 120000 })
    await session.cdp.waitForExpression('document.body && document.body.innerText.length > 100', { timeoutMs: 120000, label: '桌面首启界面出现' })
    const firstLaunchText = await session.cdp.pageText()
    await run.raw('desktop-first-launch', { text: firstLaunchText.slice(0, 4000), stdout: session.stdout(), stderr: session.stderr() })
    await session.close()
    session = null
    run.registerProcess('desktop-app-bootstrap', bootstrapPid)

    // ---- 1. 干净 profile 装基版 + SUT 钉住 ----
    await run.installBaseline({ homeDir, profileName, registryUrl })
    await verifySutInstalled(run, { homeDir, profileName, packageName: 'dsh-plugin-update-fixture-a' })

    // ---- 2. 起桌面，断言旧版面板 ----
    session = await launch()
    const mainPid = session.process.pid() ?? null
    const stateOld = await waitForFixtureLoaded(session, 180000)
    await run.raw('panel-old', stateOld)
    const oldUiOk =
      !!stateOld.card && stateOld.card.clientTag === 'client v0.0.1' && stateOld.versions.length >= 3 && stateOld.versions[0] === '0.0.1'
    run.record({
      step: '旧版面板（重启后）',
      what: '官方桌面里 A 的更新面板显示：运行版/已安装 0.0.1、夹具卡片 client v0.0.1',
      expected: '运行版=已安装=0.0.1；client 构建标记=client v0.0.1',
      actual: 'versions=[' + stateOld.versions.join(', ') + ']；clientTag=' + String(stateOld.card && stateOld.card.clientTag) + '；seal=' + String(stateOld.seal),
      verdict: oldUiOk ? 'pass' : 'fail',
    })
    await captureShot(run.recorder, session, {
      step: '旧版面板',
      what: '官方桌面窗口里的 A 面板：版本条带 0.0.1，夹具卡片显示 client v0.0.1',
      expected: '运行版=已安装=0.0.1，卡片 client v0.0.1',
      actual: 'versions=[' + stateOld.versions.join(', ') + ']；clientTag=' + String(stateOld.card && stateOld.card.clientTag),
      verdict: oldUiOk ? 'pass' : 'fail',
    })

    // ---- 3. 发布变体版（can-red 时内容固化；失败格用带注入标记的内容，避开 pnpm 共享 store 缓存） ----
    const publishedOld: PublishedFixture = (await run.publishBaseline()).a
    const variantVersion = variantVersionOf(run.scenario, 'a')
    if (!variantVersion) throw new Error('[d] 场景声明缺少 a 的变体版本')
    // 失败格注入 A：变体版内容带上本 run 独有的注入标记（seatLine/hostBehavior 各加 stamp），
    // tarball integrity 因此与历史 run 不同 —— pnpm 的共享 store 里没有这个 integrity 的缓存，
    // 删掉 tarball 后才会真的走网络下载并 404（否则命中缓存会假装成功）。构建标记仍是 v0.0.2。
    // 效果基座必须与场景声明的 THREE_EXIT_VARIANTS 一致（legacySingleEffectOf）：图案 DOM 要留单面板的
    // 版本条带，否则重启后 waitForFixtureLoaded 对批量面板永不满足（d2 第二轮实测踩过）。
    const injectedEffect: FixtureVariantEffect | undefined =
      mode === 'failure'
        ? {
            ...legacySingleEffectOf(variantVersion as '0.0.2'),
            seatLine: 'd2 失败格注入 ' + run.layout.stamp,
            hostBehavior: 'd2-failure-injection:' + run.layout.stamp,
          }
        : undefined
    let publishedNew: PublishedFixture
    if (injectedEffect) {
      publishedNew = await fixtureEnv.publish('a', variantVersion, { effect: injectedEffect })
      await run.raw('failure-variant-injection', {
        why: '失败格必须让 pnpm 真的去 registry 下载 tarball；共享 store 里已缓存历史 run 同 integrity 的 0.0.2，所以本 run 用带注入标记的内容构建（integrity 不同）',
        effect: injectedEffect,
        spec: fixtureSpecOf(publishedNew),
      })
      run.addNote(
        '失败格故障注入 A：变体版 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同、pnpm store 必然 miss；构建标记仍为 v0.0.2',
      )
    } else {
      const baselinePublication = { a: publishedOld } as Partial<Record<'a' | 'b' | 'c', PublishedFixture>> as Record<'a' | 'b' | 'c', PublishedFixture>
      const publication = await publishScenarioVariants(run.scenario, fixtureEnv, fault, baselinePublication)
      publishedNew = publication.variants.a
    }
    if (fault) {
      await run.raw('can-red-fault', { fault, expected: '重启后 clientTag 仍是 client v0.0.1（新版 UI 断言真红）', publishedNew: fixtureSpecOf(publishedNew) })
    }
    const oldClientHash = await sha256File(join(publishedOld.built.dir, 'lib', 'client.js'))
    const newClientHash = await sha256File(join(publishedNew.built.dir, 'lib', 'client.js'))
    const oldHostHash = await sha256File(join(publishedOld.built.dir, 'lib', 'index.js'))
    const newHostHash = await sha256File(join(publishedNew.built.dir, 'lib', 'index.js'))
    await run.raw('fixture-published-new', {
      spec: fixtureSpecOf(publishedNew),
      publish: { exitCode: publishedNew.publish.exitCode, stdout: publishedNew.publish.stdout, stderr: publishedNew.publish.stderr },
      artifacts: publishedNew.built.artifacts,
      hashes: { oldClientHash, newClientHash, oldHostHash, newHostHash },
    })
    run.record({
      step: '发布变体版（可见变化）',
      what: '同一包名发布 ' + variantVersion + '；新版 client bundle 与 host half 的内容哈希都和 ' + publishedOld.plan.version + ' 不同',
      expected: 'client 与 host 的 sha256 都变；registry 可见 ' + variantVersion,
      actual: 'client ' + oldClientHash.slice(0, 12) + '→' + newClientHash.slice(0, 12) + '；host ' + oldHostHash.slice(0, 12) + '→' + newHostHash.slice(0, 12),
      verdict: oldClientHash !== newClientHash && oldHostHash !== newHostHash ? 'pass' : 'fail',
    })
    const metaNew = await (async () => {
      const response = await fetch(registryUrl + '/' + publishedNew.plan.packageName)
      return (await response.json()) as { versions?: Record<string, unknown>; 'dist-tags'?: Record<string, string> }
    })().catch(() => null)
    await run.raw('registry-metadata-new', metaNew)
    const registryVersions = metaNew && metaNew.versions ? Object.keys(metaNew.versions).sort() : []
    run.record({
      step: '变体版在 registry 可见',
      what: '本地 registry 的 A 元数据包含基版与变体版（更新系统查到的 latest 就是它）',
      expected: 'versions 含 ' + publishedOld.plan.version + '、' + variantVersion,
      actual: 'versions=[' + registryVersions.join(', ') + ']；dist-tags=' + JSON.stringify((metaNew && metaNew['dist-tags']) || {}),
      verdict: registryVersions.indexOf(publishedOld.plan.version) >= 0 && registryVersions.indexOf(variantVersion) >= 0 ? 'pass' : 'fail',
    })

    // ---- 4. 真 UI：检查更新 ----
    await clickPanelAction(session, 'check')
    await waitFor(
      '面板出现可安装的 ' + variantVersion,
      async () => {
        const state = await readPanelState(session as DesktopSession).catch(() => null)
        if (!state) return null
        return state.versions[2] === variantVersion && !!state.install && state.install.disabled === false ? state : null
      },
      { timeoutMs: 180000, intervalMs: 1000 },
    )
    const stateChecked = await readPanelState(session)
    await run.raw('panel-after-check', stateChecked)
    run.record({
      step: '真 UI 检查更新',
      what: '点面板「检查更新」后，最新版变成 ' + variantVersion + '，安装按钮可用（数据来自面板 DOM 快照）',
      expected: '最新版=' + variantVersion + '；安装更新按钮 enabled',
      actual: 'versions=[' + stateChecked.versions.join(', ') + ']；install=' + JSON.stringify(stateChecked.install) + '；seal=' + String(stateChecked.seal),
      verdict: stateChecked.versions[2] === variantVersion && !!stateChecked.install && stateChecked.install.disabled === false ? 'pass' : 'fail',
    })
    await captureShot(run.recorder, session, {
      step: '检查更新后',
      what: '点击「检查更新」后的面板：最新版显示 ' + variantVersion + '，出现「安装更新」可用按钮',
      expected: '版本条带第三项=' + variantVersion + '，安装按钮可用',
      actual: 'versions=[' + stateChecked.versions.join(', ') + ']；install.disabled=' + String(stateChecked.install && stateChecked.install.disabled),
      verdict: stateChecked.versions[2] === variantVersion ? 'pass' : 'fail',
    })

    if (mode === 'failure') {
      // ---- 5F. 失败格故障注入 B：删掉变体版 tarball、元数据与 integrity 原样保留 ----
      // 为什么不是「下架版本」：产品安装前的候选门会重取版本文档并与 check 时的 release 逐字节比对，
      // 版本消失会被诚实拒绝（check-expired），根本进不到 pnpm/exec（d2 首跑实测）。
      // 这里只让 tarball 404：候选门能过，pnpm 下载时非零退出，才看得到「移除成功、重装失败」的真实失败面。
      const warm = await warmRegistryTarball({ registry, packageName: 'dsh-log', version: '0.3.4' })
      const tarballFault = await removePublishedTarball({
        registry,
        backupDir: join(run.layout.root, 'registry-tarball-backup'),
        packageName: publishedNew.plan.packageName,
        version: variantVersion,
      })
      await run.raw('registry-tarball-fault', { warm, fault: tarballFault })
      const faultOk =
        warm.status === 200 &&
        tarballFault.servedBeforeStatus === 200 &&
        tarballFault.servedBeforeBytes > 0 &&
        tarballFault.servedAfterStatus === 404 &&
        tarballFault.versionDocUnchanged &&
        tarballFault.sizeBefore > 0
      run.record({
        step: '失败格故障注入 B（删 tarball、保元数据）',
        what:
          'check 已经看到 ' +
          variantVersion +
          '；随后把该版本的 tarball 从 registry storage 删掉（元数据与 integrity 一字不改）：安装前的候选门能过，pnpm 下载 tarball 时 404 非零退出',
        expected: '删前 GET tarball=200 且字节>0；删后=404；元数据版本文档一字不差；依赖 dsh-log@0.3.4 tarball 预热=200（避免依赖下载失败掩盖根因）',
        actual:
          'warm=' +
          JSON.stringify(warm) +
          '；删前=' +
          String(tarballFault.servedBeforeStatus) +
          '/' +
          String(tarballFault.servedBeforeBytes) +
          'B；删后=' +
          String(tarballFault.servedAfterStatus) +
          '；版本文档不变=' +
          String(tarballFault.versionDocUnchanged),
        verdict: faultOk ? 'pass' : 'fail',
      })
      run.addNote('失败格故障注入 B：check 后只删 registry storage 里的 0.0.2 tarball（元数据不动），pnpm 重装时 404；备份在 run 内 registry-tarball-backup/，恢复后再执行人话格命令')

      const installClickAt = Date.now()
      await clickPanelAction(session, 'install')
      // 失败格的面板陷阱（d2 首跑实测）：本场景的夹具 A 自己就是更新面板的提供者（夹具 client half
      // require('dsh-plugin-update/panel') 并 mount），remove→install 的移除步会把提供者一起摘掉：
      // app 页面重载后既没有面板，旧 CDP 执行上下文也失效。⇒ 失败面不能拿 DOM 横幅当唯一判据，
      // 更不能伪造成「面板显示了失败」；硬证据改用台账 <home>/updates/**/state.json 收敛
      // （state=failed，message 原文里带分类、pnpm 原话与移除事实），面板可达性单独记一条诚实观测。
      const failureDeadline = Date.now() + 180000
      let failureState: PanelState | null = null
      let panelReadError: string | null = null
      let failedLedger: LedgerState | null = null
      while (Date.now() < failureDeadline) {
        const ledgerNow = await readLedgerStates(homeDir)
        failedLedger = ledgerNow.find((item) => item.state['state'] === 'failed') ?? null
        try {
          failureState = await readPanelState(session as DesktopSession)
        } catch (error) {
          panelReadError = error instanceof Error ? error.message : String(error)
        }
        if (failedLedger !== null) break
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 1500))
      }
      const failureObservedAt = Date.now()
      // 失败后产品会静默补读一次 updateStatus（#177 D3）：再等 5s 让台账/当帧命令定稿，并给面板最后一次机会。
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 5000))
      const ledgerAfterFailure = await readLedgerStates(homeDir)
      failedLedger = ledgerAfterFailure.find((item) => item.state['state'] === 'failed') ?? failedLedger
      try {
        failureState = await readPanelState(session as DesktopSession)
        panelReadError = null
      } catch (error) {
        panelReadError = error instanceof Error ? error.message : String(error)
      }
      const expectedManual =
        'dsh plugin --profile ' + profileName + ' add --save-exact ' + publishedNew.plan.packageName + '@' + variantVersion + ' --registry=' + registryUrl
      const panelReachable = failureState !== null && failureState.present
      const panelDetached = failureState !== null && !failureState.present
      const panelFailureShown =
        panelReachable &&
        failureState !== null &&
        failureState.error !== null &&
        failureState.error.indexOf('install-failed') >= 0 &&
        failureState.banner !== null &&
        failureState.banner.indexOf('更新失败') >= 0
      const ledgerFailed = failedLedger !== null
      await run.raw('panel-after-failure', {
        panelReachable,
        panelDetached,
        panelReadError,
        panelState: failureState,
        pageTextExcerpt: failureState === null ? null : (failureState.pageText ?? '').slice(0, 2000),
        ledgerFile: failedLedger === null ? null : failedLedger.file,
        ledgerState: failedLedger === null ? null : failedLedger.state,
      })
      // 失败面证据口径：面板仍挂载（present=true）就按 DOM 收横幅；面板随目标包被移除（present=false，
      // 页面回到桌面 home）就以台账 state.json 原文为硬证据，并把页面文本/读取错误记成原始观测，
      // 绝不用伪造 DOM/截图顶替。
      const panelHonestOk =
        (panelReachable && panelFailureShown) || (panelDetached && ledgerFailed) || (!panelReachable && !panelDetached && ledgerFailed && panelReadError !== null)
      run.record({
        step: '出口二失败：安装失败后的面板可达性（诚实记录）',
        what: 'remove→install 的移除步把「更新面板的提供者」（就是被更新的夹具自己）一起摘掉：面板仍挂载时收失败横幅；面板随提供者消失时页面回到桌面 home，把 present/pageText 原文与台账 failed 状态一并记下，不用伪造 DOM/截图顶替',
        expected: '面板仍挂载（present=true）→ banner 含「更新失败」且 error 含 install-failed；面板随目标包被移除（present=false）→ 页面回到桌面 home 且台账 state=failed',
        actual:
          'panelPresent=' +
          String(failureState === null ? 'unreadable' : failureState.present) +
          '；error=' +
          String(failureState === null ? null : failureState.error) +
          '；banner=' +
          String(failureState === null ? null : failureState.banner) +
          '；panelReadError=' +
          JSON.stringify(panelReadError) +
          '；ledger.state=' +
          String(ledgerFailed ? 'failed' : null),
        verdict: panelHonestOk ? 'pass' : 'fail',
      })
      run.addNote('出口二失败格：本场景的被更新夹具 A 自己就是更新面板的提供者，移除步成功后面板随目标包一起消失（present=false，产品行为正确）；失败面不伪造 DOM，硬证据取自台账 state.json 原文，页面文本/读取错误记为原始观测')
      if (panelReachable && panelFailureShown) {
        await captureShot(run.recorder, session as DesktopSession, {
          step: '安装失败后的面板',
          what: '重装失败后的面板：失败横幅 + 稳定码行（install-failed）',
          expected: '失败横幅出现，错误码行 install-failed',
          actual: 'banner=' + String(failureState === null ? null : failureState.banner) + '；error=' + String(failureState === null ? null : failureState.error),
          verdict: 'pass',
        }).catch(() => undefined)
      }

      // 先停桌面：日志缓冲要靠进程收尾冲刷，operation 日志与 state.json 也要在静态磁盘上读。
      const failurePid = session ? session.process.pid() ?? null : null
      if (session) {
        await session.close()
        session = null
      }
      run.registerProcess('desktop-app-main', failurePid)

      const logFacts = await captureLogFiles(run.recorder, homeDir)
      const execRows = eventsOf(logFacts.snapshot.events, 'update.install.exec')
      const failRows = eventsOf(logFacts.snapshot.events, 'update.install.fail')
      const windowExec = execRows.filter((row) => {
        const at = Date.parse(String(row.fields['at'] || row.fields['time'] || ''))
        return Number.isFinite(at) ? at >= installClickAt - 5000 && at <= failureObservedAt + 5000 : true
      })
      const execRow: LogEventRecord | undefined = windowExec[windowExec.length - 1] ?? execRows[execRows.length - 1]
      const failRow: LogEventRecord | undefined = failRows[failRows.length - 1]
      const execOk =
        execRow !== undefined && execRow.fields['route'] === 'desktop-manager' && execRow.fields['ok'] === false && typeof execRow.fields['exitCode'] === 'number'
      run.record({
        step: '出口二失败：exec 日志（route/ok/exitCode）',
        what: '产品日志 update.install.exec 记录本次安装走的是官方桌面插件管理器（route=desktop-manager），且以非零退出收场（ok=false、exitCode 是真实退码，不是 null）',
        expected: 'route=desktop-manager；ok=false；exitCode 为整数',
        actual: execRow ? JSON.stringify(execRow.fields) : '没有找到 update.install.exec 行（日志文件 ' + logFacts.snapshot.files.length + ' 个）',
        verdict: execOk ? 'pass' : 'fail',
      })
      const failOk =
        failRow !== undefined &&
        failRow.fields['stage'] === 'exec' &&
        failRow.fields['reason'] === 'nonzero-exit' &&
        failRow.fields['code'] === 'install-failed' &&
        typeof failRow.fields['exitCode'] === 'number'
      run.record({
        step: '出口二失败：失败八格（stage/reason/code/exitCode）',
        what: 'update.install.fail 行把宿主侧失败收成稳定分类：stage=exec、reason=nonzero-exit、code=install-failed、exitCode=真实退码；宿主码只以 hostCodeHash 出现',
        expected: 'stage=exec；reason=nonzero-exit；code=install-failed；exitCode 为整数',
        actual: failRow ? JSON.stringify(failRow.fields) : '没有找到 update.install.fail 行',
        verdict: failOk ? 'pass' : 'fail',
      })

      // operation 日志：移除步成功 + 重装步失败两步都真的跑了（窗口内非空 operation 至少 2 个）。
      const operations = await capturePluginManagerOperations({
        recorder: run.recorder,
        homeDir,
        profileName,
        window: { fromMs: installClickAt - 1000, toMs: failureObservedAt + 5000 },
      })
      const nonEmptyOps = operations.operations.filter((operation) => !operation.empty)
      const removeOperation = nonEmptyOps.find((operation) =>
        operation.removed.some((item) => item.name === publishedOld.plan.packageName && item.version === publishedOld.plan.version),
      )
      const failedAddOperation = nonEmptyOps.find((operation) => /ERR_PNPM|404/i.test(operation.pnpmLog))
      const opsOk = nonEmptyOps.length >= 2 && removeOperation !== undefined && failedAddOperation !== undefined
      run.record({
        step: '出口二失败：operation 日志（移除成功 + 重装失败两步都真的跑了）',
        what:
          '管理器窗口内至少两个非空 operation：一个 pnpm.log 命中「- ' +
          publishedOld.plan.packageName +
          ' ' +
          publishedOld.plan.version +
          '」证明移除步真的跑了；另一个含 ERR_PNPM/404 证明重装步是 pnpm 真失败（不是产品凭空报的）',
        expected: '非空 operation≥2；含移除旧版的行；含 pnpm 404 错误',
        actual:
          'count=' +
          String(operations.count) +
          '；nonEmpty=' +
          String(operations.nonEmptyCount) +
          '；order=' +
          operations.order +
          '；各 op=' +
          JSON.stringify(
            operations.operations.map((operation) => ({
              dir: operation.dirName,
              empty: operation.empty,
              removed: operation.removed,
              added: operation.added,
              hasFetch404: /ERR_PNPM|404/i.test(operation.pnpmLog),
            })),
          ),
        verdict: opsOk ? 'pass' : 'fail',
      })

      const ledger = await readLedgerStates(homeDir)
      const newest =
        ledger
          .slice()
          .sort((left, right) => String(right.state['finishedAt'] || '').localeCompare(String(left.state['finishedAt'] || '')))
          .find((item) => item.state['state'] === 'failed') ?? ledger[0]
      await run.raw('ledger-state-after-failure', { records: ledger, selected: newest ?? null })
      const jobMessage = newest && typeof newest.state['message'] === 'string' ? (newest.state['message'] as string) : ''
      const carrierCommand = executableCommandOf(jobMessage)
      // pnpm 原话经 causeExcerptOf 摘录后还要过 DETAIL_MAX_CHARS(300) 预算：本格实测末尾的
      // ERR_PNPM 码被截成「[ERR_P」。断言按被截断的真实形态放宽（只认前缀与移除事实/命令），
      // 不为了好看去改产品预算；截断事实写进 note。
      const honestSurfaceOk =
        jobMessage.indexOf('install-failed') === 0 &&
        /ERR_P(NPM_[A-Z0-9_]+)?|404|No matching version|ECONNREFUSED|fetch/i.test(jobMessage) &&
        jobMessage.indexOf('目标包已被宿主移除') >= 0 &&
        carrierCommand !== null &&
        carrierCommand.indexOf('dsh plugin --profile ' + profileName + ' add --save-exact ') >= 0
      run.record({
        step: '出口二失败：诚实人话格（移除事实 + 可执行命令 + 原话）',
        what: '宿主说包已被移除、重装失败时，人话格必须点明「目标包已被宿主移除」并给出能直接执行的重装命令；前半段保留 pnpm 原话（registry 下载失败）',
        expected:
          'job.message 以 install-failed 开头；含 pnpm 原话（ERR_PNPM/404/No matching version）；含「目标包已被宿主移除」；含 dsh plugin --profile ' +
          profileName +
          ' add --save-exact ' +
          publishedNew.plan.packageName +
          '@' +
          variantVersion,
        actual: jobMessage,
        verdict: honestSurfaceOk ? 'pass' : 'fail',
        note: 'pnpm 原文摘录被 detail 300 字预算截断（实测末尾码只剩「[ERR_P」），正则按真实被截形态放宽；分类码/移除事实/载体命令三项为硬判据',
      })

      const diskAfterFailure = await installedFixtureVersion({ homeDir, profileName, packageName: publishedNew.plan.packageName })
      const manifestAfterFailure = await readProfileManifest(join(homeDir, 'profiles', profileName))
      const dependencyAfterFailure = (manifestAfterFailure.dependencies || {})[publishedNew.plan.packageName] ?? null
      await run.raw('disk-after-failure', { diskVersion: diskAfterFailure, dependency: dependencyAfterFailure, manifest: manifestAfterFailure })
      run.record({
        step: '出口二失败：磁盘不许出现虚假成功',
        what: '重装失败后磁盘上不许是 ' + variantVersion + '：移除步已把旧版摘掉，失败要如实反映在磁盘（版本为空或不是目标版）',
        expected: 'node_modules 包版本 ≠ ' + variantVersion + '；dependencies[' + publishedNew.plan.packageName + '] ≠ ' + variantVersion,
        actual: 'node_modules 版本=' + String(diskAfterFailure) + '；dependencies=' + String(dependencyAfterFailure),
        verdict: diskAfterFailure !== variantVersion && dependencyAfterFailure !== variantVersion ? 'pass' : 'fail',
      })

      // ---- 6F. 恢复 tarball，真机执行人话格给出的命令（验收③） ----
      const restore = await restorePublishedTarball({ registry, fault: tarballFault })
      await run.raw('registry-tarball-restored', restore)
      run.record({
        step: '恢复 registry tarball（为执行人话格命令）',
        what: '把备份的 ' + variantVersion + ' tarball 放回 verdaccio storage，让失败人话格里给出的重装命令能真跑（恢复后同一 URL 重新 200，元数据仍不变）',
        expected: '恢复后 GET tarball=200；元数据版本文档仍不变',
        actual: 'restoredStatus=' + String(restore.restoredStatus) + '；元数据不变=' + String(restore.versionDocUnchanged),
        verdict: restore.restoredStatus === 200 && restore.versionDocUnchanged ? 'pass' : 'fail',
      })
      const commandText = carrierCommand ?? expectedManual
      const commandArgv = argvOfCommand(commandText)
      let manualRun: { exitCode: number | null; stdout: string; stderr: string; command: string; args: readonly string[] } | null = null
      if (commandArgv) {
        const result = await runDshCli(commandArgv, { homeDir, timeoutMs: 300000 })
        manualRun = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, command: commandText, args: result.args }
        await run.raw('manual-command-exec', {
          command: commandText,
          args: result.args,
          cwd: result.cwd,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        })
      }
      const diskAfterManual = await installedFixtureVersion({ homeDir, profileName, packageName: publishedNew.plan.packageName })
      run.record({
        step: '人话格手工命令真机执行（验收③）',
        what: '把失败人话格给出的命令原文切成 argv，用官方桌面 CLI 通道（同一入口）真跑一次：命令可执行、装回 ' + variantVersion + '、退出码 0',
        expected: '命令存在；dsh plugin add --save-exact ' + publishedNew.plan.packageName + '@' + variantVersion + ' 退出码=0；磁盘版本=' + variantVersion,
        actual: manualRun
          ? '命令=' + manualRun.command + '；exit=' + String(manualRun.exitCode) + '；磁盘=' + String(diskAfterManual) + '；stdout 摘要=' + manualRun.stdout.slice(0, 400)
          : '人话格里没有可执行命令（carrierCommand=' + String(carrierCommand) + '）',
        verdict: manualRun !== null && manualRun.exitCode === 0 && diskAfterManual === variantVersion ? 'pass' : 'fail',
      })

      // ---- 7F. 重启桌面：手工命令真的把包更新上去（可见变化） ----
      session = await launch()
      const restartPid = session.process.pid() ?? null
      const stateNew = await waitForFixtureLoaded(session, 180000)
      await run.raw('panel-after-manual', stateNew)
      const newClientOk = !!stateNew.card && stateNew.card.clientTag === 'client v0.0.2'
      const newHostOk = !!stateNew.card && stateNew.card.hostTag === 'host v0.0.2'
      run.record({
        step: '失败格：手工命令后重启桌面（可见变化）',
        what: '用失败人话格里的命令装回新版后重启隔离桌面：卡片 client/host 构建标记都变成 v0.0.2，版本条带显示 0.0.2',
        expected: 'client v0.0.2；host v0.0.2；versions 含 0.0.2',
        actual:
          'clientTag=' +
          String(stateNew.card && stateNew.card.clientTag) +
          '；hostTag=' +
          String(stateNew.card && stateNew.card.hostTag) +
          '；versions=[' +
          stateNew.versions.join(', ') +
          ']',
        verdict: newClientOk && newHostOk ? 'pass' : 'fail',
      })
      await captureShot(run.recorder, session, {
        step: '手工命令后重启的新版面板',
        what: '执行人话格命令并重启后的面板：卡片 client/host 构建标记都是 v0.0.2',
        expected: 'client v0.0.2 / host v0.0.2',
        actual: 'clientTag=' + String(stateNew.card && stateNew.card.clientTag) + '；hostTag=' + String(stateNew.card && stateNew.card.hostTag),
        verdict: newClientOk && newHostOk ? 'pass' : 'fail',
      })
      const restartPidDone = restartPid
      if (session) {
        await session.close()
        session = null
      }
      run.registerProcess('desktop-app-restart', restartPidDone)
      return await run.close()
    }

    // ---- 5S. 成功格：真 UI 点安装（in-process remove→install） ----
    const installClickAt = Date.now()
    await clickPanelAction(session, 'install')
    const installDeadline = Date.now() + 240000
    let diskVersion: string | null = null
    let lastState: PanelState | null = null
    while (Date.now() < installDeadline) {
      diskVersion = await installedFixtureVersion({ homeDir, profileName, packageName: publishedNew.plan.packageName })
      lastState = await readPanelState(session).catch(() => null)
      if (diskVersion === variantVersion) break
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 1500))
    }
    const installDoneAt = Date.now()
    await run.raw('panel-after-install', { state: lastState, diskVersion })
    const installSettled = diskVersion === variantVersion
    run.record({
      step: '真 UI 安装更新（in-process）',
      what: '点「安装更新」后，官方桌面通过 in-process remove→install 把 profile 磁盘版本换成 ' + variantVersion,
      expected: '磁盘 node_modules/<pkg>/package.json version=' + variantVersion,
      actual: '磁盘版本=' + String(diskVersion) + '；面板 seal=' + String(lastState && lastState.seal) + '；进度=' + String(lastState && lastState.progressText),
      verdict: installSettled ? 'pass' : 'fail',
    })
    await captureShot(run.recorder, session, {
      step: '安装更新后（重启前）',
      what: '安装动作结束后的面板：出现安装结果/待重启状态（面板可能在安装后重挂载，故 clientTag 允许为空）；磁盘已是 ' + variantVersion,
      expected: '安装动作结束；磁盘已是 ' + variantVersion,
      actual: 'seal=' + String(lastState && lastState.seal) + '；clientTag=' + String(lastState && lastState.card && lastState.card.clientTag) + '；磁盘=' + String(diskVersion),
      verdict: installSettled ? 'pass' : 'fail',
    })

    // ---- 6S. 停桌面 → 出口二两步配方的硬证据（operation 日志窗口内恰两次 pnpm） ----
    const mainPidDone = session ? session.process.pid() ?? null : mainPid
    if (session) {
      await session.close()
      session = null
    }
    run.registerProcess('desktop-app-main', mainPidDone)
    const operations = await capturePluginManagerOperations({
      recorder: run.recorder,
      homeDir,
      profileName,
      window: { fromMs: installClickAt - 1000, toMs: installDoneAt + 3000 },
    })
    const nonEmpty = operations.operations.filter((operation) => !operation.empty)
    const removeOp = nonEmpty.find((operation) => operation.removed.some((item) => item.name === publishedOld.plan.packageName && item.version === publishedOld.plan.version))
    const addOp = nonEmpty.find((operation) => operation.added.some((item) => item.name === publishedNew.plan.packageName && item.version === variantVersion))
    const recipeOk =
      operations.count === 2 &&
      operations.nonEmptyCount === 2 &&
      operations.order === 'remove-then-add' &&
      removeOp !== undefined &&
      addOp !== undefined &&
      removeOp.createdAt <= addOp.createdAt
    run.record({
      step: '出口二两步配方（operation 日志硬证据）',
      what: '官方桌面 in-process 插件管理器对已装包先 removeBundle 再 installBundle：窗口内恰两次非空 operation，先移除旧版（pnpm 输出 - ' + publishedOld.plan.packageName + ' ' + publishedOld.plan.version + '）、后安装新版（+ ' + publishedNew.plan.packageName + ' ' + variantVersion + '）',
      expected: '窗口内 operation 恰 2 个且都非空；顺序 remove→add；移除行命中旧版、安装行命中新版',
      actual: 'count=' + String(operations.count) + '；nonEmpty=' + String(operations.nonEmptyCount) + '；order=' + operations.order + '；操作=' + nonEmpty.map((operation) => operation.dirName + '(' + (operation.empty ? 'empty' : (operation.removed.length ? 'remove ' : '') + (operation.added.length ? 'add' : '')) + ')').join(' → '),
      verdict: recipeOk ? 'pass' : 'fail',
    })
    run.record({
      step: '出口二 already-installed 守卫处理',
      what: 'HMR 宿主的首次 installBundle 对已装包在跑 pnpm 之前就同步拒绝 already-installed；本包据此改走 remove→install，所以窗口内只有两次 pnpm 运行（没有第三次失败的 add，也没有把 already-installed 当最终失败）',
      expected: '窗口内非空 operation 恰 2 个（remove + add），且没有只失败一次就收场的第三次 pnpm',
      actual: '窗口内 operation 共 ' + String(operations.count) + ' 个（非空 ' + String(operations.nonEmptyCount) + '）',
      verdict: operations.nonEmptyCount === 2 ? 'pass' : 'fail',
    })
    const logFacts = await captureLogFiles(run.recorder, homeDir)
    const execRows = eventsOf(logFacts.snapshot.events, 'update.install.exec')
    const failRows = eventsOf(logFacts.snapshot.events, 'update.install.fail')
    const execRow: LogEventRecord | undefined = execRows[execRows.length - 1]
    const execOk = execRow !== undefined && execRow.fields['route'] === 'desktop-manager' && execRow.fields['ok'] === true && execRow.fields['exitCode'] === 0
    run.record({
      step: '出口二成功：exec 日志（route/ok/exitCode）',
      what: '产品日志 update.install.exec 记录本次更新走官方桌面插件管理器（route=desktop-manager），且以 0 收场',
      expected: 'route=desktop-manager；ok=true；exitCode=0',
      actual: execRow ? JSON.stringify(execRow.fields) : '没有找到 update.install.exec 行（日志文件 ' + logFacts.snapshot.files.length + ' 个）',
      verdict: execOk ? 'pass' : 'fail',
    })
    run.record({
      step: '出口二成功：无安装失败事件',
      what: '成功格的产品日志里不许出现 update.install.fail（成功就是成功，不靠失败事件收场）',
      expected: 'update.install.fail 行数=0',
      actual: 'update.install.fail 行数=' + String(failRows.length),
      verdict: failRows.length === 0 ? 'pass' : 'fail',
    })
    const hostKinds = logFacts.snapshot.events.filter((row) => row.event === 'update.wire.ready').map((row) => row.fields['hostKind'])
    run.record({
      step: '出口二路由判定（hostKind=desktop-manager）',
      what: '日志 update.wire.ready 的 hostKind 证明本宿主走的是官方桌面内建插件管理器出口（desktopProfiles 服务缺失 → profileName=desktop 且 pluginManager.installBundle 存在 → desktop-manager）',
      expected: 'hostKind=desktop-manager',
      actual: 'hostKind=' + JSON.stringify(hostKinds),
      verdict: hostKinds.indexOf('desktop-manager') >= 0 ? 'pass' : 'fail',
    })

    // ---- 7S. 重启隔离桌面：新版 UI + 可见变化（can-red 的红点） ----
    const manifestAfterUpdate = await readProfileManifest(join(homeDir, 'profiles', profileName))
    await run.raw('profile-manifest-after-update', manifestAfterUpdate)
    session = await launch()
    const restartPid = session.process.pid() ?? null
    const stateNew = await waitForFixtureLoaded(session, 180000)
    await run.raw('panel-new', stateNew)
    const oldTitle = (stateOld.card && stateOld.card.title) || ''
    const newClientOk = !!stateNew.card && stateNew.card.clientTag === 'client v0.0.2'
    const newHostOk = !!stateNew.card && stateNew.card.hostTag === 'host v0.0.2'
    const newTitleOk = !!stateNew.card && !!stateNew.card.title && stateNew.card.title !== oldTitle && stateNew.card.title.indexOf('新版') >= 0
    run.record({
      step: '重启后新版 UI + 可见变化',
      what: '重启隔离桌面后重新加载的是 ' + variantVersion + ' 的 client/host：卡片标题相对旧版发生变化、client 构建标记、host 桥标记都变成新版',
      expected: 'client v' + variantVersion + '；host v' + variantVersion + '；标题从「' + oldTitle + '」变为另一个值且含「新版」；运行版/已安装=' + variantVersion,
      actual: 'clientTag=' + String(stateNew.card && stateNew.card.clientTag) + '；hostTag=' + String(stateNew.card && stateNew.card.hostTag) + '；title=' + String(stateNew.card && stateNew.card.title) + '（旧：' + oldTitle + '）；versions=[' + stateNew.versions.join(', ') + ']',
      verdict: newClientOk && newHostOk && newTitleOk ? 'pass' : 'fail',
    })
    await captureShot(run.recorder, session, {
      step: '重启后新版面板',
      what: '重启后的官方桌面窗口：卡片标题变为新版变体，client/host 构建标记都是 v' + variantVersion,
      expected: 'client v' + variantVersion + ' / host v' + variantVersion + ' / 标题含「新版」',
      actual: 'clientTag=' + String(stateNew.card && stateNew.card.clientTag) + '；hostTag=' + String(stateNew.card && stateNew.card.hostTag) + '；title=' + String(stateNew.card && stateNew.card.title),
      verdict: newClientOk && newHostOk && newTitleOk ? 'pass' : 'fail',
    })

    // ---- 8S. UI/磁盘一致 + 台账 ----
    const finalDisk = await installedFixtureVersion({ homeDir, profileName, packageName: publishedNew.plan.packageName })
    const finalManifest = await readProfileManifest(join(homeDir, 'profiles', profileName))
    const finalDependency = (finalManifest.dependencies || {})[publishedNew.plan.packageName] ?? null
    await run.raw('final-disk-facts', { diskVersion: finalDisk, dependency: finalDependency, manifest: finalManifest })
    run.record({
      step: 'UI/磁盘一致（无虚假成功）',
      what: '重启后 UI 显示已安装 ' + variantVersion + '，且磁盘 profile 的 dependencies 与 node_modules 包版本都是 ' + variantVersion,
      expected: 'diskVersion=' + variantVersion + '；dependencies=' + variantVersion,
      actual: 'diskVersion=' + String(finalDisk) + '；dependencies=' + String(finalDependency),
      verdict: finalDisk === variantVersion && finalDependency === variantVersion ? 'pass' : 'fail',
    })
    const ledger = await readLedgerStates(homeDir)
    await run.raw('ledger-states', ledger)
    const completed = ledger.find((item) => String(item.state['targetVersion']) === variantVersion && (item.state['state'] === 'completed' || item.state['state'] === 'restart-required'))
    run.record({
      step: '台账（作业状态）',
      what: '更新器落盘的作业状态记录本次更新：目标版本 ' + variantVersion + '、前版本 ' + publishedOld.plan.version + '、状态为成功终态（completed 或 restart-required）',
      expected: '存在 state.json 且 targetVersion=' + variantVersion + '、previousVersion=' + publishedOld.plan.version + '、state∈{completed,restart-required}',
      actual: completed ? JSON.stringify(completed.state) : '没有匹配的 state.json；全部=' + JSON.stringify(ledger.map((item) => ({ file: item.file, state: item.state['state'], targetVersion: item.state['targetVersion'] }))),
      verdict: completed ? 'pass' : 'fail',
    })

    const finalPid = session ? session.process.pid() ?? null : restartPid
    if (session) {
      await session.close()
      session = null
    }
    run.registerProcess('desktop-app-restart', finalPid)
    return await run.close()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await run.raw('scenario-error', { message, stack: error instanceof Error ? error.stack : null }).catch(() => '')
    run.record({
      step: '场景异常',
      what: '出口二矩阵格在异常处中断（保留原始错误与当时证据）',
      expected: '主流程无异常',
      actual: message.slice(0, 1000),
      verdict: 'unknown',
    })
    run.addNote('场景异常：' + message.slice(0, 500))
    if (session) {
      try {
        await session.close()
      } catch (closeError) {
        run.addNote('收尾关桌面失败：' + (closeError instanceof Error ? closeError.message : String(closeError)))
      }
    }
    return await run.close()
  }
}
