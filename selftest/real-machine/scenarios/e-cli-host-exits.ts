/**
 * selftest/real-machine/scenarios/e-cli-host-exits.ts —— 出口三：普通 DSH 宿主 spawn CLI 子进程。
 *
 * 矩阵格（场景声明单源：identity/scenario-declarations.ts）：
 *   e1-cli-host-update-success  —— 普通 DSH 宿主（profile=t3cli，非 desktop）spawn 载体 CLI 子进程
 *                                  把 A@0.0.1 更新到 A@0.0.2；完成判据是磁盘 + 日志，不是电话回包。
 *   e2-cli-host-update-failure  —— check 正常；安装时 registry 里 0.0.2 的 tarball 被删（元数据/integrity
 *                                  不动），CLI 子进程 404 非零退出：产品记 install-failed（reason=nonzero-exit）
 *                                  + pnpm 原话；磁盘不变；随后恢复 tarball 并真机执行回包里的手工命令（验收③）。
 *   e3-cli-host-install-timeout —— 宿主 registry 指向延迟代理（pnpm 请求被挂起）+ installTimeoutMs=4s：
 *                                  产品到点终止 CLI 子进程，记 install-failed/reason=timeout + 超时原话。
 *   can-red（复用 e1 声明）          —— 发布 0.0.2 但构建内容仍是 0.0.1（stale-variant）：磁盘/元数据都说
 *                                  0.0.2，重启后 host 构建标记仍报 host v0.0.1 —— 预期「运行代码真的换了版」断言真红。
 *
 * 宿主通道 B 的隔离硬约束（探针实测）：产品 spawn 的 CLI 子进程走 scrubbedParentEnv，DSH_* 全被剥掉，
 * 子进程按 homedir()/.dsh 解析 home ⇒ 宿主 homeDir 必须正好等于 USERPROFILE/.dsh（run 内假用户目录），
 * 否则安装会落到默认 home、verify version-mismatch（见 host/cli-host.ts 文件头）。
 *
 * 证据纪律：每个断言 actual 都来自本 run 的原始观测（电话回包原文 / 磁盘 / 产品日志 / 代理请求日志 /
 * state.json）；日志在停宿主前后各读一次（缓冲要靠进程收尾冲刷），拿不到就如实记 unknown，不借别的 run。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunManifest } from '../runtime/evidence.ts'
import type { LogEventRecord, LogSnapshot } from '../runtime/log-evidence.ts'
import { captureLogFiles, eventsOf, readLogEvents } from '../runtime/log-evidence.ts'
import type { CliHostPhoneReply, CliHostSession } from '../host/cli-host.ts'
import { startCliHost } from '../host/cli-host.ts'
import { createWebProfileInHome } from '../host/isolated-profile.ts'
import { readProfileManifest, runDshCli } from '../host/dsh-cli.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import type { FixtureVariantEffect } from '../../fixtures/identity/fixture-slots.ts'
import { legacySingleEffectOf } from '../../fixtures/identity/scenario-declarations.ts'
import type { ScenarioFaultInjection } from '../runtime/scenario-runner.ts'
import { baselineVersionOf, publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import { fixtureSpecOf } from '../runtime/fixture-environment.ts'
import { fetchPublishedVersions } from '../../fixtures/release/registry-client.ts'
import type { TarballFault } from '../runtime/registry-faults.ts'
import { removePublishedTarball, restorePublishedTarball, warmRegistryTarball } from '../runtime/registry-faults.ts'
import type { DelayingRegistryProxy } from '../../fixtures/release/delaying-registry-proxy.ts'
import { startDelayingRegistryProxy } from '../../fixtures/release/delaying-registry-proxy.ts'
import { ensureDir, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { isPortFree } from '../../tooling/ports.ts'
import { isProcessAlive, waitFor } from '../../tooling/process.ts'
import { fixtureBridgeRouteOf, fixtureBuildTagPhoneOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { T3Run } from './t3-common.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'

/** 出口三的格：成功 / 失败（tarball 404→CLI 非零退出）/ 超时（延迟代理 + 4s 预算）/ can-red（stale-variant）。 */
export type CliHostExitMode = 'success' | 'failure' | 'timeout' | 'can-red'

/** 场景入参。 */
export interface CliHostExitsOptions {
  readonly worktree: string
  /** run 根目录（仓库外，例 D:/dsh-plugin/_wt263/runtime/t3-267）。 */
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  /** 维护者 DSH_HOME（只读指纹）。 */
  readonly maintainerHome?: string
  readonly mode: CliHostExitMode
}

/** 通道 B 的使用范围名：不能是 desktop（否则落到出口二）。 */
const CLI_PROFILE_NAME = 't3cli'
/** 超时格的安装预算（毫秒）；产品默认预算远大于它，能触发超时本身就证明配置透传生效。 */
const INSTALL_TIMEOUT_MS = 4000
/** 延迟代理挂起 pnpm 请求的毫秒数（必须明显大于安装预算）。 */
const PROXY_DELAY_MS = 15000

/** 电话回包里的快照形状（只取本场景用到的字段）。 */
interface CliSnapshot {
  readonly runningVersion?: string | null
  readonly installed?: boolean
  readonly installedVersion?: string | null
  readonly latestVersion?: string | null
  readonly canInstall?: boolean
  readonly blockedReason?: string | null
  readonly job?: { readonly state?: string; readonly targetVersion?: string | null; readonly message?: string | null } | null
  readonly registered?: boolean
  readonly identity?: string
}

/** 一条电话回包的解析结果。 */
interface PhoneOutcome {
  readonly reply: CliHostPhoneReply
  readonly ok: boolean
  readonly error: string | null
  readonly fields: Record<string, unknown>
  readonly snapshot: CliSnapshot | null
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

/** 发一条夹具电话并把回包解析成 {ok,error,fields,snapshot}。 */
async function callPhone(host: CliHostSession, route: string, phone: string, args: Record<string, unknown>): Promise<PhoneOutcome> {
  const reply = await host.postPhone(route, phone, args)
  const body = reply.body && typeof reply.body === 'object' ? (reply.body as Record<string, unknown>) : {}
  const fields = body['reply'] && typeof body['reply'] === 'object' ? (body['reply'] as Record<string, unknown>) : {}
  const snapshotRaw = fields['snapshot']
  const snapshot = snapshotRaw && typeof snapshotRaw === 'object' ? (snapshotRaw as CliSnapshot) : null
  return {
    reply,
    ok: body['ok'] === true,
    error: typeof body['error'] === 'string' ? (body['error'] as string) : null,
    fields,
    snapshot,
  }
}

/** 作业是否到终态（更新任务只在这些状态上收场）。 */
function terminalJobState(state: string | null | undefined): boolean {
  return state === 'completed' || state === 'restart-required' || state === 'failed' || state === 'interrupted'
}

/** 轮询 updateStatus 直到作业终态（或超时抛错，错误里带最后一次观测）。 */
async function waitForTerminalJob(
  host: CliHostSession,
  route: string,
  statusPhone: string,
  timeoutMs: number,
): Promise<{ outcome: PhoneOutcome; polls: number; elapsedMs: number }> {
  const startedAt = Date.now()
  let polls = 0
  let last: PhoneOutcome | null = null
  try {
    await waitFor(
      '更新作业终态（updateStatus 轮询）',
      async () => {
        polls += 1
        const outcome = await callPhone(host, route, statusPhone, {})
        last = outcome
        return terminalJobState(outcome.snapshot && outcome.snapshot.job ? outcome.snapshot.job.state : null) ? outcome : null
      },
      { timeoutMs, intervalMs: 1000 },
    )
  } catch (error) {
    throw new Error(
      '等更新作业终态超时：' +
        (error instanceof Error ? error.message : String(error)) +
        '；最后一次回包=' +
        JSON.stringify((last as PhoneOutcome | null)?.snapshot ?? null),
    )
  }
  const outcome = last
  if (!outcome) throw new Error('等更新作业终态失败：没有任何回包')
  return { outcome, polls, elapsedMs: Date.now() - startedAt }
}

/** 宿主还活着时轮询产品日志，等到指定事件落盘（日志缓冲需要时间；拿不到返回 null）。 */
async function waitForLogEvent(homeDir: string, eventName: string, timeoutMs: number): Promise<LogSnapshot | null> {
  try {
    return await waitFor(
      '产品日志出现 ' + eventName,
      async () => {
        const snapshot = await readLogEvents(homeDir)
        return eventsOf(snapshot.events, eventName).length > 0 ? snapshot : null
      },
      { timeoutMs, intervalMs: 500 },
    )
  } catch (error) {
    return null
  }
}

/** 把手工命令原文切成 runDshCli 的 argv（去掉开头的 dsh；命令里没有引号与空格参数）。 */
function argvOfCommand(text: string): string[] | null {
  const tokens = text.trim().split(/\s+/)
  if (tokens.length < 4 || tokens[0] !== 'dsh' || tokens[1] !== 'plugin') return null
  return tokens.slice(1)
}

/** 跑一个出口三矩阵格。 */
export async function runCliHostExits(options: CliHostExitsOptions): Promise<RunManifest> {
  const mode = options.mode
  const scenarioId =
    mode === 'success' || mode === 'can-red'
      ? 'e1-cli-host-update-success'
      : mode === 'failure'
        ? 'e2-cli-host-update-failure'
        : 'e3-cli-host-install-timeout'
  // can-red：复用成功格声明，但变体版用 stale-variant 故障注入（清单版本 0.0.2、构建内容仍是 0.0.1）。
  const fault: ScenarioFaultInjection | undefined =
    mode === 'can-red'
      ? {
          kind: 'stale-variant',
          slotKey: 'a',
          description: 'can-red：发布 0.0.2 但构建内容仍是 0.0.1（host 构建标记不变），预期重启后「运行代码真的换了版」断言真红',
        }
      : undefined
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: 'dsh-web',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
  })
  run.addNote(
    '通道 B 是无窗口 CLI 宿主：本场景的 UI 证据是 DOM/pageText 原文（电话回包、页面状态、产品日志摘录），没有 PNG 截图；官方桌面的窗口截图证据由 d1/d2（出口二）与 T10 UI 组承担。',
  )
  let host: CliHostSession | null = null
  let proxy: DelayingRegistryProxy | null = null
  const hostPids: { label: string; pid: number | null }[] = []
  try {
    const fixtureEnv = run.fixtureEnv
    if (!fixtureEnv) throw new Error('[e] 出口三场景需要夹具环境')
    const registry = fixtureEnv.registry
    const slot = fixtureSlotOf(run.scenario.install[0].slotKey)
    const packageName = slot.packageName
    const route = fixtureBridgeRouteOf(slot)
    const batch = slot.batch
    if (!batch) throw new Error('[e] 席位 ' + slot.key + ' 没有批量接线，取不到单插件电话前缀')
    const selfTarget = batch.targets.filter((target) => target.key === batch.selfKey)[0]
    if (!selfTarget) throw new Error('[e] 批量接线里没有自家目标 ' + batch.selfKey)
    const phonePrefix = selfTarget.prefix
    const checkPhone = phonePrefix + '.updateCheck'
    const installPhone = phonePrefix + '.updateInstall'
    const statusPhone = phonePrefix + '.updateStatus'
    const buildTagPhone = fixtureBuildTagPhoneOf(slot)
    const baseVersion = baselineVersionOf(run.scenario, slot.key)
    const variantVersion = variantVersionOf(run.scenario, slot.key)
    if (!variantVersion) throw new Error('[e] 场景声明缺少 ' + slot.key + ' 的变体版本')

    // ---- 1. 隔离口径：宿主 homeDir 必须正好等于 USERPROFILE/.dsh ----
    const osHomeDir = join(run.layout.root, 'os-home')
    const homeDir = join(osHomeDir, '.dsh')
    await ensureDir(osHomeDir)
    await ensureDir(homeDir)
    await run.raw('isolation-facts', {
      osHomeDir,
      homeDir,
      profileName: CLI_PROFILE_NAME,
      why:
        '产品 spawn 的 CLI 子进程走 scrubbedParentEnv，DSH_* 全被剥掉、按 homedir()/.dsh 解析 home；' +
        '宿主 homeDir 因此必须正好等于 USERPROFILE/.dsh，否则安装落到默认 home（T3 探针实测）',
      maintainerHomeUntouched: true,
    })
    run.record({
      step: '出口三隔离口径（宿主 home = USERPROFILE/.dsh）',
      what: '通道 B 宿主与它 spawn 的 CLI 子进程落在同一个 run 内隔离 home：宿主用 DSH_HOME=homeDir，子进程 DSH_* 被剥离后按 USERPROFILE/.dsh 解析',
      expected: 'homeDir=' + homeDir + '；profileName=' + CLI_PROFILE_NAME + '（≠ desktop）',
      actual: 'osHomeDir=' + osHomeDir + '；homeDir=' + homeDir + '；profileName=' + CLI_PROFILE_NAME,
      verdict: homeDir === join(osHomeDir, '.dsh') && (CLI_PROFILE_NAME as string) !== 'desktop' ? 'pass' : 'fail',
    })

    // ---- 2. 建普通 profile + 装基版 + SUT 钉住 ----
    const profile = await createWebProfileInHome({ homeDir, profileName: CLI_PROFILE_NAME })
    await run.raw('profile-create', {
      exitCode: profile.create.exitCode,
      stdout: profile.create.stdout,
      stderr: profile.create.stderr,
      profileDir: profile.profileDir,
    })
    run.record({
      step: '通道 B 建普通 profile（CLI 入口）',
      what: '用官方发行里的 CLI（dsh --profile <名> --from-default-profile web --dump-config）在隔离 home 建一个普通 DSH 使用范围；范围名不是 desktop，路由才会落到 cli 出口',
      expected: 'exit=0；profileDir=' + join(homeDir, 'profiles', CLI_PROFILE_NAME),
      actual: 'exit=' + String(profile.create.exitCode) + '；profileDir=' + profile.profileDir,
      verdict: profile.create.exitCode === 0 ? 'pass' : 'fail',
    })
    await run.installBaseline({ homeDir, profileName: CLI_PROFILE_NAME, registryUrl: registry.baseUrl })
    await verifySutInstalled(run, { homeDir, profileName: CLI_PROFILE_NAME, packageName })
    const baseDisk = await installedFixtureVersion({ homeDir, profileName: CLI_PROFILE_NAME, packageName })
    run.record({
      step: '出口三基版在盘（更新前状态）',
      what: '更新前隔离 profile 的 node_modules 里装的是场景声明的基版 ' + baseVersion,
      expected: '磁盘版本=' + baseVersion,
      actual: '磁盘版本=' + String(baseDisk),
      verdict: baseDisk === baseVersion ? 'pass' : 'fail',
    })

    // ---- 3. 发布变体版（成功/超时用声明效果；失败格用带注入标记的内容，避开 pnpm 共享 store 缓存） ----
    const baselinePublication = await run.publishBaseline()
    const publishedOld: PublishedFixture = baselinePublication[slot.key]
    // 失败格注入 A：变体版内容带上本 run 独有的注入标记（seatLine/hostBehavior 各加 stamp），
    // tarball integrity 因此与历史 run 不同 —— pnpm 的共享 store 里没有这个 integrity 的缓存，
    // 删掉 tarball 后才会真的走网络下载并 404（否则命中缓存会假装成功）。构建标记仍是 v0.0.2。
    const injectedEffect: FixtureVariantEffect | undefined =
      mode === 'failure'
        ? {
            ...legacySingleEffectOf(variantVersion as '0.0.2'),
            seatLine: 'e2 失败格注入 ' + run.layout.stamp,
            hostBehavior: 'e2-failure-injection:' + run.layout.stamp,
          }
        : undefined
    let publishedNew: PublishedFixture
    if (injectedEffect) {
      publishedNew = await fixtureEnv.publish(slot.key, variantVersion, { effect: injectedEffect })
      await run.raw('failure-variant-injection', {
        why: '失败格必须让 pnpm 真的去 registry 下载 tarball；共享 store 里已缓存历史 run 同 integrity 的 0.0.2，所以本 run 用带注入标记的内容构建（integrity 不同）',
        effect: injectedEffect,
        spec: fixtureSpecOf(publishedNew),
      })
      run.addNote(
        '失败格故障注入 A：变体版 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同、pnpm store 必然 miss；构建标记仍为 v0.0.2',
      )
    } else if (fault) {
      const publication = await publishScenarioVariants(run.scenario, fixtureEnv, fault, baselinePublication)
      publishedNew = publication.variants[slot.key]
      await run.raw('can-red-fault-injection', {
        fault,
        spec: fixtureSpecOf(publishedNew),
        why: 'can-red 故障注入：清单版本是 ' + variantVersion + '，但 tarball 内容仍是 ' + baseVersion + ' 的构建（stale-variant）；用来证明「重启后运行代码真的换了版」断言不是永真',
      })
      run.addNote('can-red 故障注入：stale-variant——变体版清单是 ' + variantVersion + '，构建内容仍是 ' + baseVersion + '；预期 buildTag 断言真红（其余成功面照常）')
    } else {
      const publication = await publishScenarioVariants(run.scenario, fixtureEnv, undefined, baselinePublication)
      publishedNew = publication.variants[slot.key]
    }
    const publishedVersions = await fetchPublishedVersions(registry.baseUrl, packageName)
    await run.raw('fixture-published-variant', {
      baseline: fixtureSpecOf(publishedOld),
      variant: fixtureSpecOf(publishedNew),
      registryVersions: publishedVersions,
    })
    run.record({
      step: '变体版发布（更新目标）',
      what: '按场景声明发布变体 ' + packageName + '@' + variantVersion + '（UI/行为都随版本变，重启后能自证）',
      expected: '本地 registry 可见版本含 ' + variantVersion,
      actual: 'registry 版本=' + JSON.stringify(publishedVersions),
      verdict: publishedVersions && publishedVersions.indexOf(variantVersion) >= 0 ? 'pass' : 'fail',
    })

    // ---- 4. 超时格：起延迟代理（pnpm 请求被挂起），宿主 registry 指向它 ----
    const hostExtraEnv: Record<string, string | undefined> = { DSH_SELFTEST_REGISTRY: registry.baseUrl }
    if (mode === 'timeout') {
      proxy = await startDelayingRegistryProxy({ upstreamBaseUrl: registry.baseUrl, delayMs: PROXY_DELAY_MS })
      hostExtraEnv['DSH_SELFTEST_REGISTRY'] = proxy.baseUrl
      hostExtraEnv['DSH_SELFTEST_INSTALL_TIMEOUT_MS'] = String(INSTALL_TIMEOUT_MS)
      await run.raw('delaying-proxy-launch', {
        baseUrl: proxy.baseUrl,
        port: proxy.port,
        upstream: registry.baseUrl,
        delayMs: PROXY_DELAY_MS,
        match: 'pnpm-user-agent',
        hostInstallTimeoutMs: INSTALL_TIMEOUT_MS,
      })
      run.record({
        step: '超时格故障注入（延迟代理 + 4s 安装预算）',
        what: '在 verdaccio 前面挂延迟代理：只有 pnpm 的请求被挂起 ' + PROXY_DELAY_MS + 'ms（产品自己的 check 不受影响）；宿主通过 DSH_SELFTEST_REGISTRY 指向代理、通过 DSH_SELFTEST_INSTALL_TIMEOUT_MS 把安装预算降到 ' + INSTALL_TIMEOUT_MS + 'ms',
        expected: '代理端口=' + proxy.port + '；upstream=' + registry.baseUrl,
        actual: '代理 baseUrl=' + proxy.baseUrl + '；delayMs=' + String(PROXY_DELAY_MS),
        verdict: 'pass',
      })
    }

    // ---- 5. 起通道 B 宿主 ----
    const mainHost = await startCliHost({ homeDir, osHomeDir, profileName: CLI_PROFILE_NAME, extraEnv: hostExtraEnv })
    host = mainHost
    hostPids.push({ label: 'cli-host-main', pid: mainHost.pid() ?? null })
    await run.raw('cli-host-launch', {
      url: host.url,
      port: host.port,
      bootMs: host.bootMs,
      profileName: host.profileName,
      stdoutTail: host.stdout().slice(-4000),
      stderrTail: host.stderr().slice(-4000),
    })
    run.record({
      step: '通道 B 宿主启动（普通 dsh web）',
      what: '用官方发行 CLI 起一个普通 DSH web 宿主（--profile ' + CLI_PROFILE_NAME + ' --port 0 --no-open），等它打印 web 地址并 HTTP 探活；这是「普通 DSH 宿主」的真机形态',
      expected: '打印 http://127.0.0.1:<port>/?token=… 且探活 status<400',
      actual: 'url=' + host.url + '；bootMs=' + String(host.bootMs),
      verdict: host.port > 0 && host.bootMs > 0 ? 'pass' : 'fail',
    })

    // ---- 6. 查更新（check） ----
    const check = await callPhone(mainHost, route, checkPhone, { trigger: 'user' })
    await run.raw('phone-update-check', { status: check.reply.status, durationMs: check.reply.durationMs, body: check.reply.body })
    const checkOk =
      check.ok &&
      check.snapshot !== null &&
      check.snapshot.runningVersion === baseVersion &&
      check.snapshot.latestVersion === variantVersion &&
      check.snapshot.canInstall === true
    run.record({
      step: '出口三 check 电话（发现新版）',
      what: '夹具电话 updateCheck 从宿主拿到快照：运行版=' + baseVersion + '、最新版=' + variantVersion + '、可安装',
      expected: 'ok=true；runningVersion=' + baseVersion + '；latestVersion=' + variantVersion + '；canInstall=true',
      actual: check.snapshot ? JSON.stringify(check.snapshot) : '没有快照；回包=' + JSON.stringify(check.reply.body),
      verdict: checkOk ? 'pass' : 'fail',
    })
    const receipt = check.fields['receipt'] && typeof check.fields['receipt'] === 'object' ? (check.fields['receipt'] as Record<string, unknown>) : null
    const checkId = receipt && typeof receipt['checkId'] === 'string' ? (receipt['checkId'] as string) : ''
    run.record({
      step: 'check 凭证（checkId）',
      what: '安装电话必须带上 check 回包给的候选凭证 checkId（不自己编）',
      expected: 'receipt.checkId 非空',
      actual: 'checkId=' + JSON.stringify(checkId) + '；receipt=' + JSON.stringify(receipt),
      verdict: checkId.length > 0 ? 'pass' : 'fail',
    })

    // ---- 7. 失败格：check 之后删掉变体版 tarball（元数据与 integrity 不变） ----
    let tarballFault: TarballFault | null = null
    if (mode === 'failure') {
      const warm = await warmRegistryTarball({ registry, packageName: 'dsh-log', version: '0.4.1' })
      tarballFault = await removePublishedTarball({
        registry,
        backupDir: join(run.layout.root, 'registry-tarball-backup'),
        packageName,
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
        step: '失败格故障注入（check 后删 tarball、保元数据）',
        what:
          'check 已经看到 ' +
          variantVersion +
          '；随后只删 registry storage 里的 tarball（元数据与 integrity 一字不改）：候选门能过，载体 CLI 子进程里的 pnpm 下载 tarball 时 404 非零退出（真实网络失败，不是注入假回包）',
        expected: '删前 GET tarball=200 且字节>0；删后=404；元数据版本文档一字不差；依赖 dsh-log@0.4.1 tarball 预热=200',
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
      run.addNote('失败格故障注入：check 后只删 registry storage 里的 0.0.2 tarball（元数据不动），CLI 子进程 pnpm 下载时 404；备份在 run 内 registry-tarball-backup/，恢复后再执行手工命令')
    }

    // ---- 8. 安装（电话只受理，完成判据用磁盘+日志） ----
    const requestId = 't3e-' + mode + '-' + String(Date.now())
    const install = await callPhone(mainHost, route, installPhone, { checkId, requestId, from: 'panel' })
    await run.raw('phone-update-install', { status: install.reply.status, durationMs: install.reply.durationMs, requestId, body: install.reply.body })
    const acceptedState = install.snapshot && install.snapshot.job ? install.snapshot.job.state : null
    run.record({
      step: '安装电话受理（异步：电话先回、exec 后完）',
      what: '安装电话只把任务接进来就回 ok:true（job.state=' + String(acceptedState) + '），真正的安装由宿主 spawn 的 CLI 子进程异步执行；所以完成判据必须用磁盘与日志，不能拿电话回包当完成',
      expected: 'ok=true；job.state∈{installing,verifying}；回包时长远小于真实安装耗时',
      actual: 'ok=' + String(install.ok) + '；job.state=' + String(acceptedState) + '；回包时长=' + String(install.reply.durationMs) + 'ms',
      verdict: install.ok && (acceptedState === 'installing' || acceptedState === 'verifying') ? 'pass' : 'fail',
    })

    // ---- 9. 轮询到作业终态 ----
    const terminal = await waitForTerminalJob(mainHost, route, statusPhone, mode === 'success' || mode === 'can-red' ? 180000 : 90000)
    const terminalSnapshot = terminal.outcome.snapshot
    const jobState = terminalSnapshot && terminalSnapshot.job ? terminalSnapshot.job.state : null
    const jobMessage = terminalSnapshot && terminalSnapshot.job && terminalSnapshot.job.message ? terminalSnapshot.job.message : ''
    const terminalManual = terminal.outcome.fields['manual']
    await run.raw('phone-status-terminal', {
      polls: terminal.polls,
      elapsedMs: terminal.elapsedMs,
      status: terminal.outcome.reply.status,
      body: terminal.outcome.reply.body,
    })

    // 超时格：在停宿主之前先取「同一宿主里的构建标记电话」——产品终止的是 CLI 子进程，
    // 宿主本身仍应活着；这条证据必须在 close() 之前采（d2/e3 首跑教训：停掉后再 fetch 只会 fetch failed）。
    let timeoutBuildTag: PhoneOutcome | null = null
    if (mode === 'timeout') {
      timeoutBuildTag = await callPhone(mainHost, route, buildTagPhone, {})
      await run.raw('phone-build-tag-after-timeout', { status: timeoutBuildTag.reply.status, body: timeoutBuildTag.reply.body })
    }

    // 宿主编排日志：先等关键行落盘（宿主还活着时轮询，日志缓冲需要时间）。
    const expectedLogEvent = mode === 'success' || mode === 'can-red' ? 'update.install.exec' : 'update.install.fail'
    const earlyLogs = await waitForLogEvent(homeDir, expectedLogEvent, 30000)
    if (earlyLogs) {
      await run.raw('logs-before-stop', {
        files: earlyLogs.files,
        execRows: eventsOf(earlyLogs.events, 'update.install.exec').length,
        failRows: eventsOf(earlyLogs.events, 'update.install.fail').length,
        unparsedLines: earlyLogs.unparsedLines,
      })
    } else {
      run.addNote('停宿主前等 ' + expectedLogEvent + ' 落盘超时（日志可能仍在缓冲；停宿主后再读一次）')
    }

    // 停宿主（冲刷日志）并登记进程；之后读日志做断言。
    const mainPid = mainHost.pid() ?? null
    await mainHost.close()
    host = null
    run.registerProcess('cli-host-main', mainPid)
    const logFacts = await captureLogFiles(run.recorder, homeDir)
    const execRows = eventsOf(logFacts.snapshot.events, 'update.install.exec')
    const failRows = eventsOf(logFacts.snapshot.events, 'update.install.fail')
    const verifyRows = eventsOf(logFacts.snapshot.events, 'update.install.verify')
    const wireRows = eventsOf(logFacts.snapshot.events, 'update.wire.ready')
    const execRow: LogEventRecord | undefined = execRows[execRows.length - 1]
    const failRow: LogEventRecord | undefined = failRows[failRows.length - 1]
    const verifyRow: LogEventRecord | undefined = verifyRows[verifyRows.length - 1]
    run.record({
      step: '出口三路由判定（hostKind=cli / exec route=cli-process）',
      what: '产品日志证明本宿主走的是「普通 DSH 宿主 spawn CLI 子进程」出口：update.wire.ready hostKind=cli，update.install.exec route=cli-process',
      expected: 'hostKind=cli；exec.route=cli-process',
      actual:
        'hostKind=' +
        JSON.stringify(wireRows.map((row) => row.fields['hostKind'])) +
        '；exec.route=' +
        JSON.stringify(execRow ? execRow.fields['route'] : null),
      verdict:
        wireRows.some((row) => row.fields['hostKind'] === 'cli') && execRow !== undefined && execRow.fields['route'] === 'cli-process'
          ? 'pass'
          : 'fail',
    })

    // ---- 10. 分格断言 ----
    if (mode === 'success' || mode === 'can-red') {
      const successState = jobState === 'restart-required' || jobState === 'completed'
      run.record({
        step: '出口三成功：作业终态',
        what: '安装任务以成功终态收场（restart-required=磁盘已更新、等重启；completed=已生效），且没有失败 message',
        expected: 'job.state∈{restart-required,completed}；job.message 为空',
        actual: 'job.state=' + String(jobState) + '；job.message=' + JSON.stringify(jobMessage) + '；轮询=' + String(terminal.polls) + ' 次/' + String(terminal.elapsedMs) + 'ms',
        verdict: successState && !jobMessage ? 'pass' : 'fail',
      })
      const diskAfter = await installedFixtureVersion({ homeDir, profileName: CLI_PROFILE_NAME, packageName })
      const manifestAfter = await readProfileManifest(join(homeDir, 'profiles', CLI_PROFILE_NAME))
      const dependencyAfter = (manifestAfter.dependencies || {})[packageName] ?? null
      await run.raw('disk-after-success', { diskVersion: diskAfter, dependency: dependencyAfter, manifest: manifestAfter })
      run.record({
        step: '出口三成功：磁盘真的换了版（无虚假成功）',
        what: '完成判据落在磁盘：profile 的 dependencies 与 node_modules 包版本都变成 ' + variantVersion,
        expected: 'diskVersion=' + variantVersion + '；dependencies=' + variantVersion,
        actual: 'diskVersion=' + String(diskAfter) + '；dependencies=' + String(dependencyAfter),
        verdict: diskAfter === variantVersion && dependencyAfter === variantVersion ? 'pass' : 'fail',
      })
      const execOk = execRow !== undefined && execRow.fields['ok'] === true && execRow.fields['exitCode'] === 0
      run.record({
        step: '出口三成功：exec 日志（route/ok/exitCode/durationMs）',
        what: 'update.install.exec 记录载体 CLI 子进程以 0 收场；durationMs 是真实安装耗时，电话回包时长应远小于它',
        expected: 'ok=true；exitCode=0；durationMs>0',
        actual: execRow ? JSON.stringify(execRow.fields) : '没有 update.install.exec 行（日志文件 ' + String(logFacts.snapshot.files.length) + ' 个）',
        verdict: execOk ? 'pass' : 'fail',
      })
      const execDuration = execRow && typeof execRow.fields['durationMs'] === 'number' ? (execRow.fields['durationMs'] as number) : 0
      run.record({
        step: '电话先回、exec 后完（异步语义）',
        what: '安装电话回包时长与真实安装耗时对比：电话不等安装完成',
        expected: '电话回包时长 < exec durationMs',
        actual: '电话=' + String(install.reply.durationMs) + 'ms；exec=' + String(execDuration) + 'ms',
        verdict: install.reply.durationMs < execDuration ? 'pass' : 'fail',
      })
      run.record({
        step: '出口三成功：无安装失败事件',
        what: '成功格的产品日志里不许出现 update.install.fail',
        expected: 'update.install.fail 行数=0',
        actual: 'update.install.fail 行数=' + String(failRows.length),
        verdict: failRows.length === 0 ? 'pass' : 'fail',
      })
      const verifyOk =
        verifyRow !== undefined &&
        (verifyRow.fields['result'] === 'restart-required' || verifyRow.fields['result'] === 'completed') &&
        verifyRow.fields['installedVersion'] === variantVersion
      run.record({
        step: '出口三成功：verify 行（装上的版本）',
        what: 'update.install.verify 记录装完后的版本核对：installedVersion=' + variantVersion,
        expected: 'result∈{restart-required,completed}；installedVersion=' + variantVersion,
        actual: verifyRow ? JSON.stringify(verifyRow.fields) : '没有 update.install.verify 行',
        verdict: verifyOk ? 'pass' : 'fail',
      })

      // 重启宿主：新装上的 host half 代码要能自证换了版。
      host = await startCliHost({ homeDir, osHomeDir, profileName: CLI_PROFILE_NAME, extraEnv: hostExtraEnv })
      hostPids.push({ label: 'cli-host-restart', pid: host.pid() ?? null })
      const buildTag = await callPhone(host, route, buildTagPhone, {})
      await run.raw('phone-build-tag-after-restart', { status: buildTag.reply.status, body: buildTag.reply.body })
      const buildTagValue = typeof buildTag.fields['buildTag'] === 'string' ? (buildTag.fields['buildTag'] as string) : ''
      const statusAfter = await callPhone(host, route, statusPhone, {})
      await run.raw('phone-status-after-restart', { status: statusAfter.reply.status, body: statusAfter.reply.body })
      const runningAfter = statusAfter.snapshot ? statusAfter.snapshot.runningVersion : null
      run.record({
        step: '出口三成功：重启后 host 代码真的换了版',
        what: '重启宿主后夹具 host half 的构建标记电话回报 ' + buildTagValue + '（标记来自新装包的代码，不是旧进程内存），运行版也变成 ' + variantVersion,
        expected: 'buildTag=host v' + variantVersion + '；runningVersion=' + variantVersion,
        actual: 'buildTag=' + JSON.stringify(buildTagValue) + '；runningVersion=' + String(runningAfter),
        verdict: buildTagValue === 'host v' + variantVersion && runningAfter === variantVersion ? 'pass' : 'fail',
      })
      const restartPid = host.pid() ?? null
      await host.close()
      host = null
      run.registerProcess('cli-host-restart', restartPid)
    } else if (mode === 'failure') {
      const failedState = jobState === 'failed'
      const messageHasCode = jobMessage.indexOf('install-failed') >= 0
      // pnpm 原话经 causeExcerptOf 摘录 + DETAIL_MAX_CHARS(300) 预算：末尾错误码可能被截成「[ERR_P」
      // （d2 同形状实测），断言按真实被截形态放宽；分类码与状态仍是硬判据。
      const messageHasDetail = /ERR_P(NPM_[A-Z0-9_]+)?|No matching version|404|E404|fetch/i.test(jobMessage)
      run.record({
        step: '出口三失败：作业失败 + 原话（诚实面）',
        what: '载体 CLI 子进程非零退出后，任务以 failed 收场；message 以稳定码 install-failed 开头并带 pnpm 原话（不吞、不美化）',
        expected: 'job.state=failed；message 含 install-failed 与 pnpm 原话（ERR_PNPM/No matching version/404）',
        actual: 'job.state=' + String(jobState) + '；job.message=' + JSON.stringify(jobMessage),
        verdict: failedState && messageHasCode && messageHasDetail ? 'pass' : 'fail',
      })
      run.record({
        step: '出口三失败：诚实面不得出现载体命令',
        what: 'registry 类失败没有可执行的人工补救命令（包被下架，重装同版本也装不上），产品不许在 detail 里塞载体命令',
        expected: 'job.message 不含 "dsh plugin"',
        actual: 'job.message=' + JSON.stringify(jobMessage),
        verdict: jobMessage.indexOf('dsh plugin') < 0 ? 'pass' : 'fail',
      })
      const execFailed = execRow !== undefined && execRow.fields['ok'] === false && typeof execRow.fields['exitCode'] === 'number'
      run.record({
        step: '出口三失败：exec 日志（route/ok/exitCode）',
        what: 'update.install.exec 记录载体 CLI 子进程非零退出（exitCode 是真实子进程退出码）',
        expected: 'route=cli-process；ok=false；exitCode 是整数',
        actual: execRow ? JSON.stringify(execRow.fields) : '没有 update.install.exec 行',
        verdict: execFailed ? 'pass' : 'fail',
      })
      const failOk =
        failRow !== undefined &&
        failRow.fields['stage'] === 'exec' &&
        failRow.fields['reason'] === 'nonzero-exit' &&
        failRow.fields['code'] === 'install-failed'
      run.record({
        step: '出口三失败：install.fail 八格（stage/reason/code）',
        what: '失败事件按契约落 stage=exec、reason=nonzero-exit、code=install-failed，其余格（hostCodeHash/check/exitCode/observedVersion/intentHash）都在',
        expected: 'stage=exec；reason=nonzero-exit；code=install-failed；八格齐全',
        actual: failRow ? JSON.stringify(failRow.fields) : '没有 update.install.fail 行',
        verdict: failOk && Object.keys(failRow ? failRow.fields : {}).length >= 8 ? 'pass' : 'fail',
      })
      const diskAfterFailure = await installedFixtureVersion({ homeDir, profileName: CLI_PROFILE_NAME, packageName })
      run.record({
        step: '出口三失败：磁盘不变（无虚假成功）',
        what: '失败后 profile 里的包仍是基版 ' + baseVersion + '，没有半装状态',
        expected: '磁盘版本=' + baseVersion,
        actual: '磁盘版本=' + String(diskAfterFailure),
        verdict: diskAfterFailure === baseVersion ? 'pass' : 'fail',
      })
      const manualText = typeof terminalManual === 'string' ? terminalManual : ''
      const manualOk =
        manualText.indexOf('--profile ' + CLI_PROFILE_NAME) >= 0 &&
        manualText.indexOf(packageName + '@' + variantVersion) >= 0 &&
        manualText.indexOf('--registry=' + registry.baseUrl) >= 0
      run.record({
        step: '出口三失败：回包手工命令（可执行）',
        what: '失败后 updateStatus 回包的 manual 是可执行命令：目标版本 ' + variantVersion + '、范围 ' + CLI_PROFILE_NAME + '、源是本地 registry',
        expected: 'manual 含 --profile ' + CLI_PROFILE_NAME + '、' + packageName + '@' + variantVersion + '、--registry=' + registry.baseUrl,
        actual: 'manual=' + JSON.stringify(manualText),
        verdict: manualOk ? 'pass' : 'fail',
      })
      // 恢复 registry tarball：然后真机执行回包给出的手工命令（验收③）。
      if (!tarballFault) throw new Error('[e] 失败格缺少 tarball 故障事实，无法恢复')
      const restore = await restorePublishedTarball({ registry, fault: tarballFault })
      await run.raw('registry-tarball-restored', restore)
      run.record({
        step: '恢复 registry tarball（为执行手工命令）',
        what: '把备份的 ' + variantVersion + ' tarball 放回 verdaccio storage，让失败回包给出的手工命令能真跑',
        expected: '恢复后 GET tarball=200；元数据版本文档仍不变',
        actual: 'restoredStatus=' + String(restore.restoredStatus) + '；元数据不变=' + String(restore.versionDocUnchanged),
        verdict: restore.restoredStatus === 200 && restore.versionDocUnchanged ? 'pass' : 'fail',
      })
      const commandArgv = manualText ? argvOfCommand(manualText) : null
      let manualResult: { exitCode: number | null; stdout: string; stderr: string; durationMs: number; argv: string[] } | null = null
      if (commandArgv) {
        const result = await runDshCli(commandArgv, { homeDir, timeoutMs: 300000 })
        manualResult = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, argv: commandArgv }
        await run.raw('manual-command-exec', {
          command: manualText,
          argv: commandArgv,
          cwd: result.cwd,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        })
      }
      const diskAfterManual = await installedFixtureVersion({ homeDir, profileName: CLI_PROFILE_NAME, packageName })
      run.record({
        step: '验收③：失败回包的手工命令真机执行',
        what: '按回包 manual 原文切出 argv（去掉开头的 dsh），用官方发行 CLI 在同一个隔离 home 里真跑一次：命令能执行、把 ' + variantVersion + ' 装上',
        expected: '命令可切 argv；exit=0；磁盘版本=' + variantVersion,
        actual: manualResult
          ? 'argv=' + JSON.stringify(manualResult.argv) + '；exit=' + String(manualResult.exitCode) + '；durationMs=' + String(manualResult.durationMs) + '；磁盘=' + String(diskAfterManual)
          : '命令切不出 argv：' + JSON.stringify(manualText),
        verdict: manualResult !== null && manualResult.exitCode === 0 && diskAfterManual === variantVersion ? 'pass' : 'fail',
      })
      // 重启宿主：手工命令装上的新 host half 要能自证。
      host = await startCliHost({ homeDir, osHomeDir, profileName: CLI_PROFILE_NAME, extraEnv: hostExtraEnv })
      hostPids.push({ label: 'cli-host-restart', pid: host.pid() ?? null })
      const buildTag = await callPhone(host, route, buildTagPhone, {})
      await run.raw('phone-build-tag-after-manual', { status: buildTag.reply.status, body: buildTag.reply.body })
      const buildTagValue = typeof buildTag.fields['buildTag'] === 'string' ? (buildTag.fields['buildTag'] as string) : ''
      run.record({
        step: '失败格收尾：手工命令真的把更新装上去（重启自证）',
        what: '重启宿主后构建标记电话回报 ' + buildTagValue + '，证明手工命令不是只读探针、真的更新了运行代码',
        expected: 'buildTag=host v' + variantVersion,
        actual: 'buildTag=' + JSON.stringify(buildTagValue),
        verdict: buildTagValue === 'host v' + variantVersion ? 'pass' : 'fail',
      })
      const restartPid = host.pid() ?? null
      await host.close()
      host = null
      run.registerProcess('cli-host-restart', restartPid)
    } else {
      // 超时格。
      const timeoutDetail = jobMessage
      const hasTimeoutDetail =
        timeoutDetail.indexOf('安装超时，已终止子进程') >= 0 ||
        timeoutDetail.indexOf('安装超时；宿主未提供终止能力，这次安装可能仍在后台继续') >= 0
      run.record({
        step: '出口三超时：作业失败 + 超时原话',
        what: '安装预算 ' + INSTALL_TIMEOUT_MS + 'ms 到点后产品按超时定局，人话（job.message）给超时原话；允许宿主未提供终止能力时的 no-terminate 变体',
        expected: 'job.state=failed；message 含「安装超时，已终止子进程」或「安装超时；宿主未提供终止能力，这次安装可能仍在后台继续」',
        actual: 'job.state=' + String(jobState) + '；job.message=' + JSON.stringify(timeoutDetail),
        verdict: jobState === 'failed' && hasTimeoutDetail ? 'pass' : 'fail',
      })
      const execDuration = execRow && typeof execRow.fields['durationMs'] === 'number' ? (execRow.fields['durationMs'] as number) : -1
      const durationInWindow = execDuration >= INSTALL_TIMEOUT_MS && execDuration < INSTALL_TIMEOUT_MS + 8000
      run.record({
        step: '出口三超时：exec durationMs 落在预算+宽限内（配置透传生效）',
        what: 'update.install.exec 的 durationMs 证明宿主真的用了 4s 预算（产品默认预算远大于它）：到点终止子进程，再给最多 3s 宽限',
        expected: 'durationMs∈[' + INSTALL_TIMEOUT_MS + ', ' + (INSTALL_TIMEOUT_MS + 8000) + ')',
        actual: execRow ? 'durationMs=' + String(execDuration) + '；fields=' + JSON.stringify(execRow.fields) : '没有 update.install.exec 行',
        verdict: execDuration >= 0 && durationInWindow ? 'pass' : 'fail',
      })
      const timeoutFailOk =
        failRow !== undefined && failRow.fields['reason'] === 'timeout' && failRow.fields['code'] === 'install-failed'
      run.record({
        step: '出口三超时：install.fail（reason=timeout / code=install-failed）',
        what: '失败事件按契约落 reason=timeout、code=install-failed',
        expected: 'reason=timeout；code=install-failed',
        actual: failRow ? JSON.stringify(failRow.fields) : '没有 update.install.fail 行',
        verdict: timeoutFailOk ? 'pass' : 'fail',
      })
      const diskAfterTimeout = await installedFixtureVersion({ homeDir, profileName: CLI_PROFILE_NAME, packageName })
      run.record({
        step: '出口三超时：磁盘不变（无虚假成功）',
        what: '超时终止后 profile 里的包仍是基版 ' + baseVersion,
        expected: '磁盘版本=' + baseVersion,
        actual: '磁盘版本=' + String(diskAfterTimeout),
        verdict: diskAfterTimeout === baseVersion ? 'pass' : 'fail',
      })
      const proxyRequests = proxy ? proxy.requests() : []
      const delayedPnpm = proxyRequests.filter((item) => item.delayed && item.userAgent.toLowerCase().indexOf('pnpm') >= 0)
      const undelayedCheck = proxyRequests.filter((item) => !item.delayed && item.url.indexOf(packageName) >= 0)
      await run.raw('delaying-proxy-requests', {
        baseUrl: proxy ? proxy.baseUrl : null,
        delayMs: PROXY_DELAY_MS,
        total: proxyRequests.length,
        delayed: delayedPnpm.length,
        requests: proxyRequests.slice(0, 40),
      })
      run.record({
        step: '出口三超时：故障注入真的挂住了 pnpm（原始请求日志）',
        what: '延迟代理请求日志证明：pnpm 的 registry 请求被挂起（delayMs=' + PROXY_DELAY_MS + '），而产品自己的 check 请求没被延迟（所以 check 能正常发现新版）',
        expected: '被延迟的 pnpm 请求 ≥1；未被延迟、命中包名的 check 请求 ≥1',
        actual: '总请求=' + String(proxyRequests.length) + '；被延迟的 pnpm 请求=' + String(delayedPnpm.length) + '；未延迟的包名请求=' + String(undelayedCheck.length),
        verdict: delayedPnpm.length >= 1 && undelayedCheck.length >= 1 ? 'pass' : 'fail',
      })
      // 同一宿主里构建标记电话仍报基版：旧进程内存里还是旧代码，没有虚假生效。
      const buildTag = timeoutBuildTag
      const buildTagValue = buildTag !== null && typeof buildTag.fields['buildTag'] === 'string' ? (buildTag.fields['buildTag'] as string) : ''
      run.record({
        step: '出口三超时：运行代码没变（同宿主自证）',
        what: '超时后同一个宿主进程里的夹具 host half 仍报基版构建标记（磁盘没换、进程也没重载）',
        expected: 'buildTag=host v' + baseVersion,
        actual: 'buildTag=' + JSON.stringify(buildTagValue),
        verdict: buildTagValue === 'host v' + baseVersion ? 'pass' : 'fail',
      })
      const timeoutPid = mainHost.pid() ?? null
      await mainHost.close()
      host = null
      run.registerProcess('cli-host-main', timeoutPid)
    }

    // ---- 11. 台账 ----
    const ledger = await readLedgerStates(homeDir)
    await run.raw('ledger-states', ledger)
    const expectedLedgerState = mode === 'success' || mode === 'can-red' ? ['completed', 'restart-required'] : ['failed']
    const ledgerHit = ledger.find((item) => {
      const state = String(item.state['state'])
      return String(item.state['targetVersion']) === variantVersion && expectedLedgerState.indexOf(state) >= 0
    })
    run.record({
      step: '出口三台账（作业状态）',
      what: '更新器落盘的作业状态记录本次更新：目标版本 ' + variantVersion + '、前版本 ' + baseVersion + '、状态=' + expectedLedgerState.join('/'),
      expected: '存在 state.json 且 targetVersion=' + variantVersion + '、previousVersion=' + baseVersion + '、state∈{' + expectedLedgerState.join(',') + '}',
      actual: ledgerHit
        ? JSON.stringify(ledgerHit.state)
        : '没有匹配的 state.json；全部=' + JSON.stringify(ledger.map((item) => ({ file: item.file, state: item.state['state'], targetVersion: item.state['targetVersion'] }))),
      verdict: ledgerHit ? 'pass' : 'fail',
    })

    // ---- 12. 收尾：停代理、确认进程/端口 ----
    const proxyPort = proxy ? proxy.port : null
    if (proxy) {
      await proxy.stop()
      proxy = null
    }
    const alivePids = hostPids.filter((item) => item.pid !== null && isProcessAlive(item.pid as number))
    if (proxyPort !== null) await run.registerPort('delaying-proxy', proxyPort)
    run.record({
      step: '收尾（进程与端口）',
      what: '所有通道 B 宿主进程都已停止、延迟代理端口已释放（真机一次只起一个宿主；不留孤儿进程）',
      expected: 'host pids 全部不在；代理端口空闲',
      actual: 'hostPids=' + JSON.stringify(hostPids) + '；仍存活=' + JSON.stringify(alivePids) + '；代理端口=' + String(proxyPort) + '，空闲=' + String(proxyPort === null ? 'n/a' : await isPortFree(proxyPort)),
      verdict: alivePids.length === 0 && (proxyPort === null || (await isPortFree(proxyPort))) ? 'pass' : 'fail',
    })
    return await run.close()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await run.raw('scenario-error', { message, stack: error instanceof Error ? error.stack : null }).catch(() => '')
    run.record({
      step: '场景异常',
      what: '出口三矩阵格在异常处中断（保留原始错误与当时证据）',
      expected: '主流程无异常',
      actual: message.slice(0, 1000),
      verdict: 'unknown',
    })
    run.addNote('场景异常：' + message.slice(0, 500))
    if (host) {
      try {
        await host.close()
      } catch (closeError) {
        run.addNote('收尾关宿主失败：' + (closeError instanceof Error ? closeError.message : String(closeError)))
      }
    }
    if (proxy) {
      try {
        await proxy.stop()
      } catch (stopError) {
        run.addNote('收尾停延迟代理失败：' + (stopError instanceof Error ? stopError.message : String(stopError)))
      }
    }
    return await run.close()
  }
}
