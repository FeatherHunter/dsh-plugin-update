/**
 * selftest/real-machine/scenarios/t3-common.ts —— T3 三出口矩阵场景的共用骨架。
 *
 * 三个出口（桌面插件管理器 / 普通 DSH 宿主 CLI / 第三方 Desktop 探测）共用同一套地基：
 *   run 目录 → 证据记录器 → 环境事实 → 维护者 home 前后指纹 → 本地 verdaccio + SUT 钉版
 *   → 场景声明驱动的基版发布与安装 → 收尾（停进程、停 registry、写 run.json/index.md）。
 *
 * 场景文件只写「这一格特有的步骤与断言」，不重复地基；所有断言 actual 必须来自真机观测
 * （DOM 快照 / 电话回包 / 磁盘 / 日志 / operation 日志原文），不许编。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunLayout } from '../runtime/run-layout.ts'
import { createRunLayout } from '../runtime/run-layout.ts'
import type { AssertionRecord, RunManifest, SutFacts } from '../runtime/evidence.ts'
import { EvidenceRecorder } from '../runtime/evidence.ts'
import { collectEnvironmentFacts } from '../runtime/environment-facts.ts'
import { captureMaintainerProfile, compareMaintainerProfile } from '../runtime/maintainer-profile.ts'
import type { FixtureEnvironment } from '../runtime/fixture-environment.ts'
import { createFixtureEnvironment, fixtureSpecOf } from '../runtime/fixture-environment.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import type { FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'
import type { ScenarioDeclaration } from '../../fixtures/identity/scenario-declarations.ts'
import { scenarioOf } from '../../fixtures/identity/scenario-declarations.ts'
import type { ScenarioInstallResult } from '../runtime/scenario-runner.ts'
import { installScenarioBaseline, publishScenarioBaseline } from '../runtime/scenario-runner.ts'
import { directoryExists, directoryFingerprint } from '../../tooling/fs-utils.ts'
import { installedPluginDir } from '../host/isolated-profile.ts'
import { isPortFree } from '../../tooling/ports.ts'

/** 开一个 T3 run 的入参。 */
export interface T3RunOptions {
  readonly worktree: string
  /** run 根目录（仓库外，例 D:/dsh-plugin/_wt263/runtime/t3-267）。 */
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  /** 场景声明 id（= 矩阵行 id = run.json 的 scenarioId）。 */
  readonly scenarioId: string
  /** 宿主通道：desktop-official（通道 A）/ dsh-web（通道 B）。 */
  readonly hostChannel: 'desktop-official' | 'dsh-web'
  readonly stamp?: string
  /** 维护者 DSH_HOME（只读指纹；不传则不记）。 */
  readonly maintainerHome?: string
  /** 不需要夹具环境的场景（出口一探测）传 false：跳过 registry/SUT 钉版/基版发布。 */
  readonly withFixtures?: boolean
}

/** 一次 T3 run 的共用上下文。 */
export interface T3Run {
  readonly options: T3RunOptions
  readonly layout: RunLayout
  readonly recorder: EvidenceRecorder
  readonly scenario: ScenarioDeclaration
  readonly fixtureEnv: FixtureEnvironment | null
  readonly notes: string[]
  readonly cleanupProcesses: { label: string; pid: number | null; aliveAfterStop: boolean }[]
  readonly cleanupPorts: { label: string; port: number; released: boolean }[]
  raw(name: string, payload: unknown): Promise<string>
  record(meta: Omit<AssertionRecord, 'id'>): AssertionRecord
  addNote(text: string): void
  registerProcess(label: string, pid: number | null): void
  /** 登记一个端口在收尾后的释放情况（在 close 之后调用）。 */
  registerPort(label: string, port: number): Promise<void>
  /** 场景声明的基版发布结果（openT3Run 时已发过一次；同版本不能向 verdaccio 重发）。 */
  publishBaseline(): Promise<Record<FixtureSlotKey, PublishedFixture>>
  /** 把场景声明的基版装进干净 profile，并核对 SUT 钉住（所有出口共用）。 */
  installBaseline(target: { homeDir: string; profileName: string; registryUrl: string }): Promise<ScenarioInstallResult[]>
  /** 收尾：停 registry、维护者 home 前后指纹、cleanup、写 run.json + index.md。 */
  close(): Promise<RunManifest>
}

/** 开一个 T3 run：建目录/记录器/夹具环境/SUT 钉版/基版发布，返回共用上下文。 */
export async function openT3Run(options: T3RunOptions): Promise<T3Run> {
  const layout = await createRunLayout({ baseDir: options.runBaseDir, ticket: '267', stamp: options.stamp })
  const environment = collectEnvironmentFacts(options.worktree, options.hostChannel)
  const recorder = new EvidenceRecorder({ layout, scenarioId: options.scenarioId, environment })
  const scenario = scenarioOf(options.scenarioId)
  const notes: string[] = []
  const cleanupProcesses: T3Run['cleanupProcesses'] = []
  const cleanupPorts: T3Run['cleanupPorts'] = []
  const maintainerBefore = options.maintainerHome
    ? await captureMaintainerProfile(options.maintainerHome).catch(() => ({}) as Record<string, string>)
    : null
  let fixtureEnv: FixtureEnvironment | null = null
  // 基版只能向 verdaccio 发一次（同版本不可覆盖）：openT3Run 发过就缓存下来，installBaseline/场景复用。
  let baselinePublication: Record<FixtureSlotKey, PublishedFixture> | null = null
  const raw = (name: string, payload: unknown): Promise<string> => recorder.raw(name, payload)
  const record = (meta: Omit<AssertionRecord, 'id'>): AssertionRecord => recorder.recordAssertion(meta)
  const run: T3Run = {
    options,
    layout,
    recorder,
    scenario,
    get fixtureEnv() {
      return fixtureEnv
    },
    notes,
    cleanupProcesses,
    cleanupPorts,
    raw,
    record,
    addNote: (text: string) => {
      notes.push(text)
    },
    registerProcess: (label: string, pid: number | null) => {
      cleanupProcesses.push({ label, pid, aliveAfterStop: false })
    },
    registerPort: async (label: string, port: number) => {
      cleanupPorts.push({ label, port, released: await isPortFree(port) })
    },
    publishBaseline: async () => {
      if (!fixtureEnv) throw new Error('[t3] 场景没有夹具环境，不能发布基版')
      if (!baselinePublication) baselinePublication = await publishScenarioBaseline(scenario, fixtureEnv)
      return baselinePublication
    },
    installBaseline: async (target) => {
      if (!fixtureEnv) throw new Error('[t3] 场景没有夹具环境，不能装基版')
      if (!baselinePublication) baselinePublication = await publishScenarioBaseline(scenario, fixtureEnv)
      const publication = baselinePublication
      const results = await installScenarioBaseline(scenario, publication, target)
      await raw('install-baseline', {
        profileName: target.profileName,
        results: results.map((item) => ({ slotKey: item.slotKey, packageName: item.packageName, version: item.version, facts: item.facts, install: item.install })),
      })
      for (const item of results) {
        const ok = item.facts.installedPackageJsonVersion === item.version && item.install.exitCode === 0
        record({
          step: '干净 profile 装基版（' + item.slotKey + '）',
          what: '隔离 home 的新 profile 里，dsh plugin add 装上 ' + item.packageName + '@' + item.version + '，磁盘清单三处（dependencies/bundles/包内 package.json）一致',
          expected: 'dependencies=' + item.version + '；bundles 含 ' + item.packageName + '；node_modules 包版本=' + item.version,
          actual: 'dependencies=' + String(item.facts.dependencyVersion) + '；bundles=[' + item.facts.bundles.join(', ') + ']；磁盘版本=' + String(item.facts.installedPackageJsonVersion) + '；exit=' + String(item.install.exitCode),
          verdict: ok ? 'pass' : 'fail',
        })
      }
      return results
    },
    close: async () => {
      if (fixtureEnv) {
        const port = fixtureEnv.registry.port
        try {
          await fixtureEnv.stop()
          await run.registerPort('registry', port)
        } catch (error) {
          notes.push('收尾停 registry 失败：' + (error instanceof Error ? error.message : String(error)))
        }
        fixtureEnv = null
      }
      if (options.maintainerHome && maintainerBefore) {
        const maintainerAfter = await captureMaintainerProfile(options.maintainerHome).catch(() => ({}) as Record<string, string>)
        recorder.setMaintainerProfile(compareMaintainerProfile(options.maintainerHome, maintainerBefore, maintainerAfter))
      }
      recorder.setCleanup({ processes: cleanupProcesses, ports: cleanupPorts, notes })
      for (const note of notes) recorder.addNote(note)
      return recorder.finish()
    },
  }
  // 环境地基：本地 registry + SUT 钉版 + 场景基版发布（出口一探测格不需要夹具，跳过）。
  if (options.withFixtures !== false) {
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
    const publication = await publishScenarioBaseline(scenario, fixtureEnv)
    baselinePublication = publication
    await raw('fixture-published-baseline', {
      scenario: scenario.id,
      baseline: Object.keys(publication).map((key) => ({ slotKey: key, spec: fixtureSpecOf(publication[key as keyof typeof publication]) })),
    })
    const specs = Object.keys(publication).map((key) => fixtureSpecOf(publication[key as keyof typeof publication]))
    record({
      step: '基版夹具发布',
      what: '按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死）',
      expected: '声明里的每个基版 spec 都在 registry 可见',
      actual: specs.join(', '),
      verdict: specs.length > 0 ? 'pass' : 'fail',
    })
  }
  return run
}

/** 核对 profile 里装上的 SUT dist 与工作树 dist 同指纹（真机测的是当前构建）。 */
export async function verifySutInstalled(run: T3Run, target: { homeDir: string; profileName: string; packageName: string }): Promise<boolean> {
  const fixtureEnv = run.fixtureEnv
  if (!fixtureEnv) throw new Error('[t3] 场景没有夹具环境，不能核对 SUT')
  const sut = fixtureEnv.sut
  const profileDirAbs = join(target.homeDir, 'profiles', target.profileName)
  const candidates = [
    join(profileDirAbs, 'node_modules', sut.name, 'dist'),
    join(installedPluginDir({ homeDir: target.homeDir, profileName: target.profileName, packageName: target.packageName }), 'node_modules', sut.name, 'dist'),
  ]
  let installedSutDist: string | null = null
  for (const candidate of candidates) {
    if (await directoryExists(candidate)) {
      installedSutDist = candidate
      break
    }
  }
  if (!installedSutDist) throw new Error('[t3] 在 profile 里找不到已安装的 ' + sut.name + '/dist，候选：' + candidates.join(' | '))
  const installedDist = await directoryFingerprint(installedSutDist)
  const match = installedDist.digest === sut.distDigest
  run.recorder.setSut({
    name: sut.name,
    version: sut.version,
    tarball: sut.tarball,
    tarballSha256: sut.tarballSha256,
    distDigest: sut.distDigest,
    distFiles: sut.distFiles,
    registryUrl: fixtureEnv.registry.baseUrl,
    installedDistDigest: installedDist.digest,
    installedDistMatch: match,
  })
  await run.raw('sut-installed-dist', {
    installedSutDist,
    installedDist: { digest: installedDist.digest, files: installedDist.files },
    workspaceDist: { digest: sut.distDigest, files: sut.distFiles },
    match,
  })
  run.record({
    step: 'SUT 钉住核对',
    what: '夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版）',
    expected: sut.distDigest,
    actual: installedDist.digest + '（文件数 ' + installedDist.files + ' / 工作树 ' + sut.distFiles + '）',
    verdict: match ? 'pass' : 'fail',
  })
  return match
}

/** 按版本读磁盘上夹具包的已装版本（profile 内 node_modules；读不到返回 null）。 */
export async function installedFixtureVersion(target: { homeDir: string; profileName: string; packageName: string }): Promise<string | null> {
  try {
    const dir = installedPluginDir(target)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? null
  } catch (error) {
    return null
  }
}
