// src/host/factory.ts —— 宿主装配入口（#227 从 host.ts 搬出，蓝图 §4 host 域）。
//
// 一次调用得到该插件的一组电话名与处理器（HostUpdate）：日志接线（ADR-0005）、家目录与
// 使用范围覆盖、更新说明缓存与噪声账、logAppend 协议、失败任务诊断都在这里装配。
// 公开面由包根壳 src/host.ts 收口（dist/host.js 冻结，map #220 §5）。

import {
  wireHostKind,
  readEnvForPanel,
  probeExternalGate,
  updateLogRootDir,
  watchDesktopPnpm,
  setSharedDesktopService,
  type PhoneEnvView,
} from './environment.js'
import { getSharedReader, resetSharedUpdateReaderState, type ReaderOverrides } from './capabilities.js'
import {
  loggedPhone,
  loggedChangelogPhone,
  queueArgsOf,
  wantsEnv,
  checkExpiredError,
  updateBusyError,
  type StatusPollMemory,
  type PollFailureMemory,
} from './phones.js'

import { homedir } from 'node:os'
import { sep } from 'node:path'
import {
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  buildPhoneNames,
  resolveUpdateConfig,
  type PhoneNames,
  type UpdateConfigInput,
} from '../shared/config.js'
import { manualCommand, normalizeApprovedBuilds } from '../shared/commands.js'
import { fetchReleaseChangelogOutcome, type ReleaseChangelogOutcome } from '../core/changelog/io.js'
import {
  isChangelogDegraded,
  isChangelogTruncated,
  parseChangelogReport,
  shouldFetchChangelog,
  type ChangelogContentStatus,
} from '../core/changelog/parse.js'
import { buildDiag, type DiagObject } from '../shared/diag.js'
import { hash8 } from '../shared/hash.js'
import { readHubStatus } from './hub/aggregate.js'
import { emptyHubSnapshot } from '../core/hub/snapshot.js'
import { emitUpdateLog, logEmitterCounts } from '../log/emit.js'
import { pruneEventFields } from '../core/gate.js'
import { buildUpdateLogHealth, type UpdateLogHealth, type UpdateLogWiring } from '../log/health.js'
import { buildUpdateManifest, currentUpdateEventTable, primeUpdateEventTable, updateContractStatus, type UpdateContractStatus } from '../log/manifest.js'
import { deriveLogNamespace } from '../log/namespace.js'
import { isClientLogEvent, LOG_LEVELS } from '../log/client-queue.js'
import { acquireOwnLog, logDirHash } from '../log/registry.js'
import { ownPackageVersion, packageRoot } from '../log/own-version.js'
import { updateLogRouter } from '../log/router.js'
import { createPendingSink, sinkFromLogCtx, type LogSink } from '../log/sink.js'
import { fetchNpmVersionRelease, isVersionAllowedInChannel, updateError, validReleaseVersion, validRequestId } from '../core/service.js'
import { selfCopyLevelOf, type SelfCopyLevel } from '../shared/self.js'
import { createUpdateReader, defaultHomeDir } from '../core/reader.js'
import { resolveRegistryHost } from '../shared/redaction.js'
import type { CheckTrigger, EnvironmentKind, InstallSource, UpdateLogPort } from '../shared/ports.js'
import {
  cancelEnqueuedInQueue,
  enqueueInQueue,
  isHeadOfQueue,
  queuePositionOf,
  visibleQueueFor,
  type VisibleQueue,
} from '../core/queue/model.js'

function manualOfEnv(
  env: { profileName?: string | null; sourceInstall?: boolean } | null,
  snapshot: { latestVersion?: string | null; installedVersion?: string | null; runningVersion?: string | null; job?: { targetVersion?: string | null } | null; blockedReason?: string | null } | null,
  config: ReturnType<typeof resolveUpdateConfig>
): string | null {
  try {
    return manualCommand({
      profileName: env?.profileName ?? null,
      latestVersion: snapshot?.latestVersion ?? null,
      installedVersion: snapshot?.installedVersion ?? null,
      runningVersion: snapshot?.runningVersion ?? null,
      jobTargetVersion: snapshot?.job?.targetVersion ?? null,
      blockedReason: (snapshot?.blockedReason as never) ?? null,
      sourceInstall: env?.sourceInstall === true,
      targetPackageName: config.targetPackageName,
      registryUrl: config.registryUrl,
      releaseChannel: config.releaseChannel,
    })
  } catch {
    return null
  }
}

async function snapWithManual(
  reader: ReturnType<typeof createUpdateReader>,
  snapshot: { latestVersion?: string | null; installedVersion?: string | null; runningVersion?: string | null; job?: { targetVersion?: string | null } | null; blockedReason?: string | null },
  config: ReturnType<typeof resolveUpdateConfig>
): Promise<{ snapshot: unknown; manual: string | null; diag?: DiagObject }> {
  try {
    const out: { snapshot: unknown; manual: string | null; diag?: DiagObject } = {
      snapshot,
      manual: manualOfEnv(await reader.readEnv(), snapshot, config),
    }
    // 失败任务的机读诊断（#156 第四轮）：安装是异步的，拦下时回包照旧 ok:true，失败只在快照任务里。
    // 这里把宿主自己知道的包名补回 diag，面板才不必拿插件标识当包名去猜（详见 failedJobDiagOf）。
    const diag = failedJobDiagOf(snapshot, { targetPackageName: config.targetPackageName, registryUrl: config.registryUrl })
    return diag ? { ...out, diag } : out
  } catch {
    return { snapshot, manual: null }
  }
}
/**
 * 失败任务的机读诊断（#156 对抗审查第四轮）。
 *
 * 安装是异步的：装上被年龄门拦下时，安装电话回包照旧是 ok:true，真正的失败只出现在之后
 * status 回包的快照任务里（state=failed，message=「失败码: 原文」）。这条路上以前没有 diag，
 * 面板只能拿**插件标识**当包名去认失败原文；而真宿主（dsh-life-pack）给的标识是 `life-<key>`
 * 这类派生值，与 npm 包名（dsh-prompt 之类）不是一回事——于是「装合规版」四个入口在生产形状下
 * 全都认不出因（fail-closed 成一枚死按钮）。
 *
 * 这里让宿主把自己知道的两件事（目标包名、失败原文）按同一套 buildDiag 组装回 diag：
 * 面板的机读路（causeKind／causePackage／targetPackageName）即可命中，不再靠标识撞运气。
 * 只在失败任务上带；查询成功且无失败任务时一个键都不加，旧形状逐字不变（#21）。
 */
export function failedJobDiagOf(
  snapshot: unknown,
  input: { targetPackageName?: unknown; registryUrl?: unknown },
): DiagObject | undefined {
  try {
    const snap = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : null
    const job = snap && snap['job'] && typeof snap['job'] === 'object' ? (snap['job'] as Record<string, unknown>) : null
    if (!job || job['state'] !== 'failed') return undefined
    const message = typeof job['message'] === 'string' ? job['message'] : ''
    const at = message.indexOf(':')
    const code = (at > 0 ? message.slice(0, at) : message).trim()
    const detail = at > 0 ? message.slice(at + 1).trim() : ''
    if (!code) return undefined
    // 电话种类只在「解码 → 阶段」这一步有用：失败码自带上下文（install-* 即安装侧），认不出的码
    // 落到同一支兜底（buildDiag 里 deriveStage 对未知 kind 也按安装上下文解），故这里不问调用方。
    const phoneKind = code.startsWith('install') ? 'update-install' : code.startsWith('check') ? 'update-check' : 'update-status'
    const jobRequestId = typeof job['requestId'] === 'string' ? job['requestId'] : ''
    const built = buildDiag({
      errorCode: code,
      phoneKind,
      // 任务里只剩「码 + 原文」；把原文放回 detail 格，翻译官照旧从同一处挑因。
      error: detail ? { code, detail } : { code },
      // #207：把任务里的请求编号带进诊断，回包 diag.intentHash 与日志失败行同值，跨落点可聚合。
      args: jobRequestId ? { requestId: jobRequestId } : {},
      targetPackageName: input.targetPackageName,
      registryUrl: input.registryUrl,
      // #215：缺席目标没有运行版——集成方给缺席包注入的占位版号（0.0.0 之类）不许进诊断，
      // 与面板复制文本同一口径（快照里也不该再有，这里对旧形状兜底）。
      runningVersion: snap && snap['installed'] === false ? null : snap?.['runningVersion'],
    })
    return built && typeof built === 'object' ? built : undefined
  } catch {
    return undefined
  }
}
/**
 * 落点类型：与既有生态的 `logCtx` 同形（只有 `fire`，可选 `isEnabled`）。
 * 名字保留是因为集成方的 deps 类型引用了它；实现已迁进内核（`src/log/sink.ts`）。
 */
type LogCtx = LogSink | null
/**
 * 接线身份（#211 AC-2）：`update.wire.ready` 除 `logSink` / `logDirHash` 之外的三格自述。
 * 值域已冻结在 `event-list.update.json`：`copyLevel` / `hostKind` 有枚举，`updaterVersion` 没有（null 照写）。
 */
interface UpdateLogIdentity {
  /** 本包自己的版本；读不到时显式 null（不省格，免得看日志的人分不清「旧版没这格」与「不知道」）。 */
  updaterVersion: string | null
  /** 本包这份代码的安装形态（profile / nested / repo / unknown）。 */
  copyLevel: SelfCopyLevel
  /** 宿主种类（desktop / desktop-manager / cli）。 */
  hostKind: EnvironmentKind
}
/**
 * 接线日志：把落点挂进路由表，并如实记一条 `update.wire.ready`。
 *
 * 归属规则（ADR-0005 决策 2）：集成方给了 `logCtx` 就用它的实例，本包绝不再开第二个写者；
 * 没给就自建 dsh-log 实例（同一目录在同一进程里只有一个句柄，由内核登记表兜住，跨副本也只有一个）；
 * 自建失败就降级成「没有落点」并**解绑** —— 之后每一行都计入丢弃，绝不回退到别人的 sink。
 *
 * 建库是异步的（`dsh-log/node` 要动态 import 再读盘），而 `createHostUpdate` 是同步契约，
 * 所以先接一个「先收后转」的待接落点：建好了按序灌进真落点，建不起来就整体丢弃。
 *
 * 返回的是一份**可变接线状态**（#212）：调用方持有它，回包读数据此回答「日志到底有没有在写」。
 * 里面只有事实与 8 位指纹，**没有目录路径**。
 */
function wireUpdateLog(
  homeDir: string,
  prefix: string,
  pluginId: string,
  namespace: string,
  integratorLogCtx: unknown,
  integratorEventList: unknown,
  identity: UpdateLogIdentity
): UpdateLogWiring {
  const logsRoot = updateLogRootDir(homeDir)
  const namespaceDirHash = logDirHash(`${logsRoot}${sep}${namespace}`)
  // 初始是 pending：自建实例的建库是异步的，落定之前**不许**报 self 也不许报 off。
  const wiring: UpdateLogWiring = {
    pluginId,
    sink: 'pending',
    dirHash: namespaceDirHash,
    external: null,
    reason: null,
    pendingSink: null,
    handle: null,
  }
  const external = sinkFromLogCtx(integratorLogCtx)
  if (external) {
    updateLogRouter.bind(pluginId, external)
    wiring.sink = 'external'
    // 对方写到哪本包不猜：external 不给目录指纹（连自己的预期目录也不给，免得被读成「它在写这儿」）。
    wiring.dirHash = null
    wiring.external = probeExternalGate(external)
    // AC-2 准入语义：只有探针**验证通过**（open）才许自称 external；closed/unknown/抛错 一律 external-unverified。
    // closed 的落点会自己拒收这一行（发射口按 isEnabled 跳过），所以那一格在落点上本来就看不见——如实说没验证。
    const logSink = wiring.external === 'open' ? 'external' : 'external-unverified'
    // 这一行的 logDirHash 是**本包算出的预期目录指纹**，不是对方实例实际写的目录：
    // 回包 logHealth.dirHash 在 external 支恒为 null，两者不要互相对照（README 第 11 节明说）。
    emitUpdateLog('info', 'update.wire.ready', { logSink, logDirHash: namespaceDirHash, ...identity }, { pluginId })
    return wiring
  }
  const pending = createPendingSink()
  wiring.pendingSink = pending
  updateLogRouter.bind(pluginId, pending.sink)
  void (async (): Promise<void> => {
    const built = await buildUpdateManifest(namespace, integratorEventList)
    const got = await acquireOwnLog({
      logsRoot,
      namespace,
      prefix,
      eventList: built.manifest,
      onDegrade: (reason) => {
        // 建不起来的坏消息只能如实记下（此刻没有落点可写，所以这行多半也到不了任何文件）。
        emitUpdateLog('warn', 'update.log.degraded', { reason }, { pluginId })
      },
    })
    if (got.sink) {
      pending.attach(got.sink)
      wiring.sink = 'self'
      wiring.dirHash = logDirHash(got.dir)
      wiring.handle = got.handle
      emitUpdateLog('info', 'update.wire.ready', { logSink: 'self', logDirHash: logDirHash(got.dir), ...identity }, { pluginId })
      return
    }
    pending.attach(null)
    updateLogRouter.unbind(pluginId, pending.sink)
    wiring.sink = 'off'
    // 降级也要报「本来该写哪」的指纹：没有它，对方连去哪个目录确认「确实没日志」都不知道。
    wiring.dirHash = namespaceDirHash
    wiring.reason = got.reason ?? 'write-fail'
    emitUpdateLog('info', 'update.wire.ready', { logSink: 'off', logDirHash: namespaceDirHash, ...identity }, { pluginId })
  })()
  return wiring
}
export interface HostUpdate {
  phoneNames: PhoneNames
  handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>
  /** #250：只读全局进度电话全名（`<前缀>.updateHubStatus`）。每套集成更新系统都注册。 */
  hubStatus: string
}
/**
 * 建宿主更新能力：一次调用得到该插件的一组电话名与处理器（调用方负责注册进自己的电话表）。
 * 配置只经函数入参注入（冻结写法，第 11 条），插件标识必填，其余可选。
 */
export function createHostUpdate(deps: { ctx?: unknown; logCtx?: LogCtx; logEventList?: unknown; desktopPnpm?: unknown; pluginManager?: unknown; readerOverrides?: ReaderOverrides } = {}, configInput: UpdateConfigInput): HostUpdate {
  const config = resolveUpdateConfig(configInput)
  const pluginId = config.pluginId
  // 日志接线：先起随包清单的加载，再按「外部实例优先、没有才自建」挂落点（ADR-0005）。
  // 家目录与 getSharedReader（第 417 行）同一优先级：显式覆盖 > 配置 > DSH_HOME/家目录。
  const logOverrides = (deps.readerOverrides ?? {}) as ReaderOverrides
  const logHomeDir =
    logOverrides.homeDir ?? config.homeDir ?? defaultHomeDir(logOverrides.env ?? process.env, logOverrides.osHome ?? homedir())
  primeUpdateEventTable()
  // 宿主上下文：探测宿主种类（桌面 / 普通 DSH）并接上执行零件（子进程口子、桌面服务）。
  // #211：接线身份里的 hostKind 要在接线**之前**算好——external 支的 wire.ready 是同步发的。
  const ctx = deps.ctx ?? null
  const logIdentity: UpdateLogIdentity = {
    updaterVersion: ownPackageVersion(),
    copyLevel: selfCopyLevelOf(packageRoot()),
    hostKind: wireHostKind(logOverrides, ctx),
  }
  // 接线状态是活的（#212）：`updateStatus` 每次回包都从它现算 logHealth，不缓存读数。
  const logWiring = wireUpdateLog(logHomeDir, config.prefix, pluginId, deriveLogNamespace(pluginId), deps.logCtx, deps.logEventList, logIdentity)
  if (deps.desktopPnpm) setSharedDesktopService(deps.desktopPnpm)
  else watchDesktopPnpm(ctx)
  const readerOverrides = { ...(deps.readerOverrides ?? {}), ctx, ...(deps.pluginManager ? { pluginManager: deps.pluginManager } : {}) } as ReaderOverrides
  const phoneNames = buildPhoneNames(config.prefix)
  // 更新日志按版本记住结果（#41 终裁 + #213）：缓存条目存「文本 + 成因」一整条，成功与取不到都按版本永久记
  // （宿主进程级，不落盘）。**取数失败也进缓存**：今天 fetchReleaseChangelogOutcome 把网络/超时/integrity/JSON
  // 全吞成 `fetch-failed` 返回、不抛错，所以同一版重查命中缓存正是要区分的「缓存了失败」那一格；真抛错的老路径
  // （若将来改回去）才不进缓存、下次重查。轮询退避由面板侧按 shouldFetchChangelog 门控，宿主侧总视为手动。
  // 缓存命中也要发一行（status:'cache-hit' + cached:true），但**回包里的 status 仍是那次取数的原始内容态**：
  // 缓存命中不得把「取数失败」冒充成「包里没这个文件」（面板据此分文案，见 #213）。
  const changelogCache = new Map<string, ReleaseChangelogOutcome>()
  const changelogFailedAt = new Map<string, number>()
  // #213 噪声账是**两层**：① `emitUpdateLog` 里进程级的边沿指纹（src/log/emit.ts）只压**相邻**同形行——
  // 行按事件名记「上一条指纹」，所以同 (version,status,cached) 的行中间夹了别的行（别的版本/别的状态）就还能再发；
  // ② 下面这个 Set 是**本宿主实例**的账，同一组合只发一次（交错回放不再发）。
  // 合成效果（verify-213 实测）：同 (version,status,cached) 的相邻行每进程至多一行；另一个 createHostUpdate 实例
  // 查同版本时，它自己的 Set 是空的，但若中间没有别的 changelog 行，②那行会被①压掉——这是边沿机制的正常语义，
  // 不是缺陷。稳态 0 行；同一版最多两行（取数那一行 + 之后的缓存命中一行），兑现票面噪声承诺。
  const changelogEmitted = new Set<string>()

  /**
   * 落一行更新说明证据（#213）：resident + 边沿，同 (version,status,cached) 每进程至多一行（见上面两层账）。
   * `status` 记的是**取数方式位**（缓存命中即 `cache-hit`），`degraded` 按缓存里那条**内容态**算——
   * 于是 (cache-hit, degraded:false) 与 (cache-hit, degraded:true) 能分开「缓存了成功」与「缓存了失败」。
   */
  function emitChangelogParse(version: string, outcome: ReleaseChangelogOutcome, cached: boolean): void {
    try {
      const status = cached ? 'cache-hit' : outcome.status
      const edgeKey = `${version}|${status}|${cached ? '1' : '0'}`
      if (changelogEmitted.has(edgeKey)) return
      const report = parseChangelogReport(outcome.markdown ?? '')
      emitUpdateLog('info', 'update.changelog.parse', {
        version,
        entries: Array.isArray(report.entries) ? report.entries.length : 0,
        truncated: isChangelogTruncated(report.truncation),
        degraded: isChangelogDegraded(outcome.status),
        status,
        cached,
        source: 'npm',
      }, { pluginId })
      changelogEmitted.add(edgeKey)
    } catch { /* 打点绝不影响取日志 */ }
  }

  async function readChangelog(args: Record<string, unknown>): Promise<{
    version: string
    markdown: string | null
    status: ChangelogContentStatus
    cached: boolean
  }> {
    const raw = args ? (args as Record<string, unknown>)['version'] : undefined
    if (!validReleaseVersion(raw)) throw updateError('invalid-release')
    const version = raw as string
    if (!isVersionAllowedInChannel(version, config.releaseChannel)) throw updateError('invalid-release')
    if (changelogCache.has(version)) {
      const cachedOutcome = changelogCache.get(version) as ReleaseChangelogOutcome
      emitChangelogParse(version, cachedOutcome, true)
      return { version, markdown: cachedOutcome.markdown, status: cachedOutcome.status, cached: true }
    }
    try {
      let nowMs = 0
      try { nowMs = Date.now(); } catch { nowMs = 0; }
      const failedAt = changelogFailedAt.has(version) ? (changelogFailedAt.get(version) as number) : null
      void shouldFetchChangelog({ hasCache: false, failedAt: failedAt, now: nowMs, isManual: true })
    } catch { }
    const fetchImpl = (readerOverrides as { fetchImpl?: unknown }).fetchImpl ?? (globalThis as unknown as { fetch?: unknown }).fetch
    // #211：更新说明取数也留 `update.registry.fetch` 行（ondemand 档）——与查新共用同一台打点器口径，
    // 行里只有 httpStatus / latencyMs / registryHost，绝不带 tarball 地址或正文；发射口抛错由取数层吞掉。
    const logPort: UpdateLogPort = (level, event, fields, opts) => emitUpdateLog(level, event, fields, { ...opts, pluginId })
    const registryHost = resolveRegistryHost(config.registryUrl)
    const release = await fetchNpmVersionRelease(fetchImpl as never, config.checkTimeoutMs, {
      targetPackageName: config.targetPackageName,
      registryUrl: config.registryUrl,
      releaseChannel: config.releaseChannel,
      version,
      emitLog: logPort,
      registryHost,
    })
    let outcome: ReleaseChangelogOutcome
    try {
      outcome = await fetchReleaseChangelogOutcome(
        fetchImpl,
        { tarball: release.tarball, integrity: release.integrity, version },
        {
          targetPackageName: config.targetPackageName,
          registryUrl: config.registryUrl,
          timeoutMs: config.checkTimeoutMs,
          emitLog: logPort,
          registryHost,
        },
      )
    } catch (err) {
      try { changelogFailedAt.set(version, Date.now()); } catch { try { changelogFailedAt.set(version, 0); } catch {} }
      throw err
    }
    changelogCache.set(version, outcome)
    try { changelogFailedAt.delete(version); } catch { }
    // changelog 解析（#124，ondemand 档）：宿主侧只**多算一次统计**用于落行，不改回包形状
    // （回包仍是原文，渲染方自己解析）。#213 起这次统计连同成因一起进 resident 边沿行。
    emitChangelogParse(version, outcome, false)
    return { version, markdown: outcome.markdown, status: outcome.status, cached: false }
  }
  async function readStatus(args: Record<string, unknown>): Promise<{
    snapshot: unknown
    manual: string | null
    logContract?: UpdateContractStatus
    logHealth?: UpdateLogHealth
    env?: PhoneEnvView | null
    queue?: VisibleQueue | null
  }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const out = await snapWithManual(reader, (await reader.status()) as never, config)
    // 契约健康（#210）：除了清单状态，还带「本进程有多少行在没尺子的情况下仍落盘」——
    // 这就是「字段门禁不被静默绕过」的可核对数字（0 才是真的全都量过）。
    const logContract: UpdateContractStatus = { ...updateContractStatus(), unvalidated: logEmitterCounts().unvalidated }
    // 日志健康（#212）：落点、指纹、丢弃数、最近一次到过落点的时间——「日志是空的」从此可判定。
    // 现算（接线状态是活的）；取不到就不带这个键，老回包形状一字不变。
    const logHealth = buildUpdateLogHealth(logWiring)
    const env = wantsEnv(args) ? { env: await readEnvForPanel(reader) } : {}
    const { includeQueue, showOthers } = queueArgsOf(args)
    if (!includeQueue) return { ...out, logContract, ...(logHealth ? { logHealth } : {}), ...env }
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : undefined
    return {
      ...out,
      logContract,
      ...(logHealth ? { logHealth } : {}),
      ...env,
      queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId),
    }
  }
  async function readCheck(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null; receipt: unknown; env?: PhoneEnvView | null; queue?: VisibleQueue | null }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    // 触发方只有调用方知道（面板同一支电话里既有用户点也有自动跑）：报了才落 `update.check.start`（#124）。
    const askedBy: CheckTrigger | undefined =
      args && typeof args['trigger'] === 'string' ? (args['trigger'] as CheckTrigger) : undefined
    const result = await reader.check(askedBy)
    const withManual = await snapWithManual(reader, result.snapshot as never, config)
    const env = wantsEnv(args) ? { env: await readEnvForPanel(reader) } : {}
    const { includeQueue, showOthers } = queueArgsOf(args)
    if (!includeQueue) return { snapshot: withManual.snapshot, manual: withManual.manual, receipt: result.receipt ?? null, ...(withManual.diag ? { diag: withManual.diag } : {}), ...env }
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : undefined
    return {
      snapshot: withManual.snapshot,
      manual: withManual.manual,
      receipt: result.receipt ?? null,
      ...(withManual.diag ? { diag: withManual.diag } : {}),
      ...env,
      queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId),
    }
  }
  /**
   * 合规版决议电话（#156）：面板把翻译官结论里"调用方知道"的部分递进来
   *（kind/blame/目标版/窗口/发布时间），核心取时间表做五值裁决；有候选即落
   * 第二槽凭证并随回包带回。取数失败诚实抛（面板退通用老路），永不编造候选。
   * 回包形状走 loggedPhone 通用包装：snapshot 格即决议结果，receipt 格即候选凭证。
   */
  async function readCheckFallback(args: Record<string, unknown>): Promise<{ snapshot: unknown; receipt: unknown }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const blameRaw = args && typeof args['blame'] === 'string' ? args['blame'] : undefined
    const windowSourceRaw = args && typeof args['windowSource'] === 'string' ? args['windowSource'] : undefined
    const result = await reader.checkFallback({
      ...(args && typeof args['kind'] === 'string' && args['kind'] ? { kind: args['kind'] as string } : {}),
      ...(blameRaw === 'target' || blameRaw === 'other-package' || blameRaw === 'unknown' ? { blame: blameRaw as 'target' | 'other-package' | 'unknown' } : {}),
      ...(args && typeof args['targetVersion'] === 'string' && args['targetVersion'] ? { targetVersion: args['targetVersion'] as string } : {}),
      ...(args && typeof args['windowMs'] === 'number' && Number.isFinite(args['windowMs']) ? { windowMs: args['windowMs'] as number } : {}),
      ...(windowSourceRaw === 'message' || windowSourceRaw === 'host' || windowSourceRaw === 'unknown' ? { windowSource: windowSourceRaw as 'message' | 'host' | 'unknown' } : {}),
      ...(args && typeof args['publishedAtMs'] === 'number' && Number.isFinite(args['publishedAtMs']) ? { publishedAtMs: args['publishedAtMs'] as number } : {}),
    })
    return { snapshot: { verdict: result.verdict, candidate: result.candidate }, receipt: result.receipt ?? null }
  }
  async function runInstall(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null; env?: PhoneEnvView | null; queue?: VisibleQueue | null }> {
    const checkId = args && typeof args.checkId === 'string' ? args.checkId : ''
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : ''
    // 安装意图来源（#124）：调用方自报就照传（批量驱动报 `'batch'`），认不出按 `'panel'`——
    // 老调用方不传即现状，只影响日志行 `update.install.request.from`，不参与任何决策。
    const installFrom: InstallSource =
      args && (args['from'] === 'panel' || args['from'] === 'entry' || args['from'] === 'batch')
        ? (args['from'] as InstallSource)
        : 'panel'
    // 候选安装（#156）：调用方点"装合规版"时带候选版；不带即走 latest 老路。
    // 只做形状提取（非空字符串），绑定校验归核心第二槽——这里不认任何版本。
    const installVersion = args && typeof args['version'] === 'string' && args['version'] ? String(args['version']) : undefined
    // 批准构建名单（#194）：上一次失败点名「需要批准的构建脚本」后，调用方决定批准时把宿主给的
    // 精确包名带回；形状归一在这里做（只认安全包名），核心零导入契约不破。不传即现状。
    const approvedBuilds = normalizeApprovedBuilds(args ? args['approvedBuilds'] : undefined)
    const { includeQueue, showOthers } = queueArgsOf(args)
    const enqueueOnly = !!args && args['enqueueOnly'] === true
    const cancelQueued = !!args && args['cancelQueued'] === true
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const envPatch = wantsEnv(args) ? { env: await readEnvForPanel(reader) } : {}
    // 取消占位：只撤自己的 waiting 条目（owner 不经这里取消），顺带回快照与队列。
    if (cancelQueued) {
      if (!validRequestId(requestId)) throw checkExpiredError()
      const current = await reader.readQueuePruned()
      const next = cancelEnqueuedInQueue(current, pluginId, requestId)
      if (next.removed) await reader.writeQueueState(next.state)
      const out = await snapWithManual(reader, (await reader.status()) as never, config)
      return { ...out, ...envPatch, queue: visibleQueueFor(next.state, pluginId, showOthers, requestId) }
    }
    // 只占位不装：面板先取号再装，供公平排队用（幂等占一位）。
    if (enqueueOnly) {
      if (!validRequestId(requestId)) throw checkExpiredError()
      const current = await reader.readQueuePruned()
      const placed = enqueueInQueue(current, { pluginId, requestId, targetVersion: null, enqueuedAt: reader.queueNow() })
      if (placed.state !== current) await reader.writeQueueState(placed.state)
      const out = await snapWithManual(reader, (await reader.status()) as never, config)
      return { ...out, ...envPatch, queue: visibleQueueFor(placed.state, pluginId, showOthers, requestId) }
    }
    // 正常安装：凭证不齐交给核心判（归类与改造前一致）；齐了先占位再过公平门。
    // 候选版随凭证一起进核心（#156）：核心只认第二槽绑定，占位仍按插件+编号，不按版本。
    if (!checkId || !validRequestId(requestId)) {
      const out = await snapWithManual(reader, (await reader.install({ checkId, requestId, from: installFrom, ...(installVersion ? { version: installVersion } : {}), ...(approvedBuilds.length > 0 ? { approvedBuilds } : {}) })) as never, config)
      if (!includeQueue) return { ...out, ...envPatch }
      return { ...out, ...envPatch, queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId) }
    }
    const before = await reader.readQueuePruned()
    const placed = enqueueInQueue(before, { pluginId, requestId, targetVersion: null, enqueuedAt: reader.queueNow() })
    if (placed.state !== before) await reader.writeQueueState(placed.state)
    // 公平门：非队首直接忙（沿用 update-busy，不新增码）；已是拥有者（同编号重复提交）
    // 不受此门阻拦，交给核心按旧结果返回。
    if (queuePositionOf(placed.state, pluginId, requestId) !== 0 && !isHeadOfQueue(placed.state, pluginId, requestId)) {
      // #207：公平门拒绝也要留一行原因（用户侧「点了没反应/被拒」四态之一）；
      // 意图哈希与核心侧同一算法，失败行与请求行/诊断回包可聚合。
      try {
        emitUpdateLog(
          'warn',
          'update.install.fail',
          {
            stage: 'gate',
            reason: 'gate-refused',
            code: 'update-busy',
            hostCodeHash: 'none',
            check: 'none',
            exitCode: null,
            observedVersion: null,
            intentHash: hash8(requestId),
          },
          { pluginId },
        )
      } catch {}
      throw updateBusyError()
    }
    try {
      const out = await snapWithManual(reader, (await reader.install({ checkId, requestId, from: installFrom, ...(installVersion ? { version: installVersion } : {}), ...(approvedBuilds.length > 0 ? { approvedBuilds } : {}) })) as never, config)
      // #218：成功收下也要撤掉自家 waiting 占位——核心按 requestId 幂等命中旧结果时不会写任务，
      // 镜像写队列那条路也就不会替我们清；不清就会留下「队首已无人消费」的僵尸占位。
      try {
        const current = await reader.readQueuePruned()
        const next = cancelEnqueuedInQueue(current, pluginId, requestId)
        if (next.removed) await reader.writeQueueState(next.state)
      } catch {}
      if (!includeQueue) return { ...out, ...envPatch }
      return { ...out, ...envPatch, queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId) }
    } catch (error) {
      // 忙失败留占位（面板凭它轮询位置，忙时失败回包不带队列，凭查状态补看）；
      // 其余失败撤占位，不留僵尸。
      if ((error as { code?: unknown })?.code !== 'update-busy') {
        try {
          const current = await reader.readQueuePruned()
          const next = cancelEnqueuedInQueue(current, pluginId, requestId)
          if (next.removed) await reader.writeQueueState(next.state)
        } catch {}
      }
      throw error
    }
  }
  /**
   * 客户端日志电话（#122）：面板侧的行经这里写进本插件的**同一个** log handle —— 单写者语义不变。
   *
   * 三条纪律：
   *   1. **永不抛**：形状坏成什么样都只回 `{ accepted, dropped }`（面板侧据此计数，不会因为日志把功能搞挂）。
   *   2. **不自我放大**：这个电话**不产生 `host.call` 行**（否则每送一批日志就多一行电话日志），
   *      所以它不经过 `loggedPhone`，直接进表。
   *   3. **口径分明**：协议层拒收（形状不对 / 级别不认识 / 不是客户端事件 / 整行事件不在清单 / 超量 / 过期）
   *      计入 `dropped`；**字段不合清单只摘该字段**（#210：整行仍接收，由发射口记字段级降级行），
   *      引擎因调试开关关掉而 skip 的按需行也不计 drop（那是准入，不是丢行）。
   */
  const LOG_APPEND_MAX_ROWS = 200
  const LOG_APPEND_MAX_FIELD_CHARS = 4096
  const LOG_APPEND_STALE_MS = 10 * 60_000
  /** #214：宿主拒收上浮只记一次；这个电话每秒都可能被叫，上浮也必须能防刷。 */
  let clientBatchRefusedLogged = false
  function logAppendRows(args: Record<string, unknown>): { accepted: number; dropped: number } {
    let accepted = 0
    let dropped = 0
    try {
      const raw = args && typeof args === 'object' ? (args as Record<string, unknown>)['rows'] : undefined
      if (!Array.isArray(raw)) return { accepted: 0, dropped: 0 }
      const rows = raw.slice(0, LOG_APPEND_MAX_ROWS)
      dropped += Math.max(0, raw.length - rows.length)
      let nowMs = 0
      try {
        nowMs = Date.now()
      } catch {
        nowMs = 0
      }
      const table = currentUpdateEventTable()
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          dropped++
          continue
        }
        const r = row as Record<string, unknown>
        const level = r['level']
        const event = r['event']
        const fields = r['fields']
        const ts = r['ts']
        if (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level)) { dropped++; continue }
        if (typeof event !== 'string' || !isClientLogEvent(event)) { dropped++; continue }
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { dropped++; continue }
        if (typeof ts !== 'number' || !Number.isFinite(ts)) { dropped++; continue }
        if (nowMs > 0 && nowMs - ts > LOG_APPEND_STALE_MS) { dropped++; continue }
        // #214：客户端只许上报「客户端自己的丢弃原因」，不许替宿主断言 no-dsh-log/write-fail 这类事实。
        if (event === 'update.log.degraded') {
          const reason = (fields as Record<string, unknown>)['reason']
          if (typeof reason !== 'string' || !reason.startsWith('client-')) { dropped++; continue }
        }
        let size = 0
        try {
          size = JSON.stringify(fields)?.length ?? 0
        } catch {
          size = LOG_APPEND_MAX_FIELD_CHARS + 1
        }
        if (size > LOG_APPEND_MAX_FIELD_CHARS) { dropped++; continue }
        // #210：与发射口同一把尺子 —— 未声明/枚举外的字段只丢该字段，整行仍接收；
        // 只有「整行都不该要」的情况（事件不在清单）才在这里计 dropped。
        // 原始字段交给发射口：那里负责裁剪并记字段级降级行，这里不重复裁剪，
        // 否则「丢过字段」这件事在落点就看不见了。
        if (table && pruneEventFields(table, event, fields as Record<string, unknown>).unknownEvent) {
          dropped++
          continue
        }
        emitUpdateLog(level, event, fields as Record<string, unknown>, { pluginId })
        accepted++
      }
    } catch {
      // 电话永不抛：任何意外都只回计数（面板侧的丢弃计数是唯一诚实的说法）。
    }
    // #214：拒收不能再沉默。没有这类客户端日志的落点就在这里说一句（只记原因，不记内容）；
    // 同一实例只上浮一次，防刷由 flag 保证（emit 层不按 reason 去重）。
    if (dropped > 0 && !clientBatchRefusedLogged) {
      clientBatchRefusedLogged = true
      try {
        emitUpdateLog('warn', 'update.log.degraded', { reason: 'client-batch-refused' }, { pluginId })
      } catch {
        /* 上浮失败也不能影响回包 */
      }
    }
    return { accepted, dropped }
  }

  // 轮询抑制记忆（#124）：实例级，不跨实例、不跨插件（同一个 updateStatus 电话每 1s 一次）。
  const statusPollMemory: StatusPollMemory = new Map()
  // 轮询失败限速记忆（#209）：实例级；只喂给 updateStatus，成功即清（恢复信号）。
  const statusFailMemory: PollFailureMemory = new Map()
  // #250：只读全局进度电话。每套集成更新系统都登记（单插件宿主同样），集成方传 hub:false 也照常答：
  // 快照从盘上聚合（方案 + 各属主批量账本 + 检查知识 + 活租约），中枢在不在、面板开没开都不影响答案。
  const hubStatusName = config.prefix + '.updateHubStatus'
  const hubStatusPhone = async (): Promise<Record<string, unknown>> => {
    const at = Date.now()
    try {
      const reader = await getSharedReader(pluginId, config, readerOverrides)
      return { ok: true, snapshot: await readHubStatus(reader.hubScope, { at }) }
    } catch {
      // 只读电话永不抛：读不出来就如实给空快照（坏文件按「缺失」的同一口径）。
      return { ok: true, snapshot: emptyHubSnapshot(at) }
    }
  }
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
    [phoneNames.updateStatus]: loggedPhone(
      phoneNames.updateStatus,
      'update-status',
      pluginId,
      readStatus,
      { config, readerOverrides },
      statusPollMemory,
      statusFailMemory,
    ),
    [phoneNames.updateCheck]: loggedPhone(phoneNames.updateCheck, 'update-check', pluginId, readCheck, {
      config,
      readerOverrides,
    }),
    [phoneNames.updateInstall]: loggedPhone(phoneNames.updateInstall, 'update-install', pluginId, runInstall, {
      config,
      readerOverrides,
    }),
    [phoneNames.updateCheckFallback]: loggedPhone(phoneNames.updateCheckFallback, 'update-check-fallback', pluginId, readCheckFallback, {
      config,
      readerOverrides,
    }),
    [phoneNames.updateChangelog]: loggedChangelogPhone(phoneNames.updateChangelog, pluginId, readChangelog, {
      config,
      readerOverrides,
    }),
    [phoneNames.logAppend]: async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
      logAppendRows(args && typeof args === 'object' ? args : {}),
    // #250：只读全局进度电话（名字只从前缀派生）。
    [hubStatusName]: hubStatusPhone,
  }
  return { phoneNames, handlers, hubStatus: hubStatusName }
}
// 未用到的默认值引用（保持与旧实现同一份超时口径，类型检查不误删常量）。
void DEFAULT_CHECK_TIMEOUT_MS
void DEFAULT_CONFIRMATION_TTL_MS
void DEFAULT_INSTALL_TIMEOUT_MS
/** 测试与门禁复位单例（正常运行不调用，规格 #591 第 6 条保留）。 */
export function __resetSharedUpdateReaderForTests(): void {
  resetSharedUpdateReaderState()
  setSharedDesktopService(null)
}
