/**
 * src/service.ts — 更新模块的业务流程（安装闭环）。
 *
 * 由 update-core/src/service.ts 原样拎入：只记得规矩，不动手装：查状态读本地、查新版联网问一次、
 * 装前复核用的凭证与指纹在这里生成与比对，安装的排队、去重、复核、备份顺序也在此。
 * 真正的跑腿（读盘、联网、拼命令、执行）全在适配器，本文件零导入，依赖全当参数传。
 *
 * 相对原样的增量（规格 #591 第 4、5 条）：目标包名、官方源、联网超时、凭证有效期经 UpdatePorts
 * 的可选字段注入，默认值等于现状常量（冻结默认值）。不传即走现状，老调用零变化。
 */

import type {
  BlockedReason,
  CheckResult,
  CheckTrigger,
  CompliantVerdict,
  CompliantVersionInput,
  CompliantWindowSource,
  EnvironmentView,
  FallbackCheckInput,
  FallbackCheckResult,
  FetchImpl,
  InstallSource,
  MinimalResponse,
  ReleaseInfo,
  UpdateCore,
  UpdateErrorCode,
  UpdateJob,
  UpdateLogPort,
  UpdatePorts,
  UpdateSnapshot,
} from './ports.js'

export const CONFIRMATION_TTL_MS = 10 * 60_000
/** 2 秒内重复点击复用上次结果，不重新联网。 */
export const RECHECK_WINDOW_MS = 2_000

/**
 * 请求编号是否合法（#19 收紧：非空、去空格后 1 到 128 个字符，且为不透明编号形状）。
 *
 * 收紧内容：只收 `[A-Za-z0-9._~-]`（UUID 与 `req-1` 形都在内），拒绝路径 / 令牌 / 邮箱 /
 * 键值对 / URL 用户信息形状——要放进诊断块的正是接入方经公开电话传进来的这个值，
 * 旧口径下路径与令牌形状的字符串都能通过（见 #19 Out of Scope 第 1 件）。
 * 属公开契约变更（破冰范围）：兼容说明与迁移口径见 #19 进度区——调用方请用 UUID 或同形状不透明串，
 * 不要把路径、令牌、邮箱、URL 当编号传；旧的合法不透明串（`req-1`、`id-N`、UUID）不受影响。
 */
export function validRequestId(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const id = v.trim()
  if (id.length < 1 || id.length > 128) return false
  if (!/^[A-Za-z0-9._~-]+$/.test(id)) return false
  if (/^(npm_|gh[pousr]_|github_pat_|sk-|bearer)/i.test(id)) return false
  return true
}

// 判定核已搬家（#165 第二刀）：实体见 ./version-judgment.js，本文件只留垫片＋内部引用。
// tests 深引用（../dist/service.js）与包导出表零碰（#159 冻结）。
import {
  compareReleaseVersions,
  isVersionAllowedInChannel,
  satisfiesNodeRange,
  updateError,
  validReleaseVersion,
  validVersion,
} from './version-judgment.js'
import type { ReleaseChannel } from './version-judgment.js'
export {
  compareVersions,
  compareReleaseVersions,
  isPrereleaseVersion,
  isVersionAllowedInChannel,
  RELEASE_CHANNELS,
  satisfiesNodeRange,
  updateError,
  validReleaseChannel,
  validReleaseVersion,
  validVersion,
} from './version-judgment.js'
export type { ReleaseChannel } from './version-judgment.js'
// 检查结论编排已搬家（#163 故事 3 收尾）：实体见 ./check-conclusion.js，本文件只留内部引用。
// 纯函数零值依赖；从未进包导出表，无垫片需要（#159 冻结）。
import { httpStatusOfError, installSourceOf, stableCodeOf, stageOfError, triggerOf } from './check-conclusion.js'
// ---------- 取数垫片（#163：实现搬 registry-fetch，老位置 re-export，行为零变化） ----------
import {
  CHECK_TIMEOUT_MS,
  NPM_REGISTRY,
  PACKAGE_NAME,
  fetchNpmRelease,
  fetchNpmVersionRelease,
  fetchPackumentTimes,
} from './registry-fetch.js'
export {
  CHECK_TIMEOUT_MS,
  INTEGRITY_PATTERN,
  MAX_METADATA_BYTES,
  NPM_REGISTRY,
  PACKAGE_NAME,
  fetchNpmRelease,
  fetchNpmVersionRelease,
  fetchPackumentTimes,
} from './registry-fetch.js'

// ---------- 核心工厂（记得规矩，不动手装） ----------

interface CheckedState {
  release: ReleaseInfo
  checkId: string | null
  checkedAt: number
  expiresAt: number
  installationKey: string | null
  blockedReason: BlockedReason | null
}

/**
 * 合规版候选凭证槽（#156）：**模块级**，按安装指纹寻址——不是读取器实例的私有状态。
 *
 * 为什么必须搬出来（2026-10-17 对抗审查 B2，实证）：宿主侧 `sharedReader` 是**单例**
 * （src/host.ts:75/291/453），批量面板逐家打电话时，每取下一家的读取器都会把上一家
 * 丢出缓存；凭证若活在被丢掉的读取器实例里，「装合规版」在 N≥2 的批量里必然
 * check-expired（确认时已是新读取器、槽是空的），逐行路径也活不过一次 1.5s 轮询
 * （轮询会重建每一家的读取器）。槽只存"用户看见的那个候选 + 它的凭证"，
 * 绑定与到期校验一字不动。
 */
interface FallbackSlot {
  version: string
  release: ReleaseInfo
  checkId: string
  checkedAt: number
  expiresAt: number
  installationKey: string | null
  /** 那次决议的输入（#156 M3）：确认时用它重跑一次，见 `resolveCompliantNow`。 */
  decision: FallbackDecision
}

/**
 * 一次决议的输入（#156 M3）：确认时必须拿**同一批输入**重跑决议——凭证活在十秒到十分钟之间，
 * 而门限会过期、新版会发布；"当时可装"不等于"现在还是最新可装"。输入存下来，复核才不是另写一套判据。
 */
interface FallbackDecision {
  kind: string
  windowMs: number
  windowSource: CompliantWindowSource
  publishedAtMs: number | null
  targetVersion: string | null
}

/** 槽上限：只留最近几次决议，超出即丢最旧（凭证本来只活 10 分钟）。 */
const FALLBACK_SLOT_MAX = 16
const fallbackSlots = new Map<string, FallbackSlot>()
/** 没有安装指纹时的退路：按核心实例隔离，与搬出来之前的行为一致（不做跨家共享）。 */
let fallbackInstanceSeq = 0

/** 测试专用：清空模块级凭证槽（模块状态不该跨用例串味）。 */
export function __resetFallbackSlots(): void {
  fallbackSlots.clear()
}

export function createUpdateCore(ports: UpdatePorts): UpdateCore {
  const checkTimeoutMs = ports.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  const confirmationTtlMs = ports.confirmationTtlMs ?? CONFIRMATION_TTL_MS
  const targetPackageName = ports.targetPackageName ?? PACKAGE_NAME
  const registryUrl = ports.registryUrl ?? NPM_REGISTRY
  const releaseChannel: ReleaseChannel = ports.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  // 日志发射口（#124）：中立文件不 import node，发射函数由建口人**绑好插件标识**后注入；
  // 不注入即不记——默认等于现状，老调用一字不动。行的四纪律（脱敏/白名单/准入/预算）都在发射口里。
  const logPort: UpdateLogPort | null = typeof ports.emitLog === 'function' ? ports.emitLog : null
  // 白名单源主机名（#124）：同样由 Node 侧解析后注入，不在白名单即省略该格（省略本身即信息）。
  const registryHost = typeof ports.registryHost === 'string' && ports.registryHost ? ports.registryHost : null
  /** 行只从唯一发射口出；发射口坏了也绝不挡检查与安装（注入方可能是第三方实现）。 */
  function emit(level: string, event: string, fields: Record<string, unknown>, opts?: { always?: boolean }): void {
    if (!logPort) return
    try {
      logPort(level, event, fields, opts)
    } catch {
      /* 记日志绝不挡功能 */
    }
  }
  function fetchRelease(tolerateOutOfChannel = false): Promise<ReleaseInfo> {
    return fetchNpmRelease(ports.fetchImpl, checkTimeoutMs, {
      targetPackageName,
      registryUrl,
      releaseChannel,
      tolerateOutOfChannel,
      emitLog: logPort ?? undefined,
      registryHost,
    })
  }
  let checked: CheckedState | null = null
  /**
   * 合规版候选第二槽（#156）：读写都经模块级槽（见 FallbackSlot 注释），本实例只留一个
   * 隔离键——有安装指纹时按指纹共享（跨读取器、跨轮询都活着），没有时按实例隔离。
   * `check()` 成功即清掉同一指纹的旧槽（新 latest 可能改变全局），非候选裁决按实例清
   * （没有指纹可认时不许按"猜的键"去清别家的槽——那正是 B2 那类互踩）。
   * `install()` 的候选分支只认这一槽，永不复用 `checked`（"查到啥装啥"的单向管道不动）。
   */
  const fallbackInstanceKey = `instance:${++fallbackInstanceSeq}`
  const fallbackKeyOf = (installationKey: string | null): string =>
    typeof installationKey === 'string' && installationKey ? `installation:${installationKey}` : fallbackInstanceKey
  const readFallbackSlot = (installationKey: string | null): FallbackSlot | null =>
    fallbackSlots.get(fallbackKeyOf(installationKey)) ?? null
  const writeFallbackSlot = (slot: FallbackSlot): number => {
    const key = fallbackKeyOf(slot.installationKey)
    fallbackSlots.delete(key)
    fallbackSlots.set(key, slot)
    while (fallbackSlots.size > FALLBACK_SLOT_MAX) {
      const oldest = fallbackSlots.keys().next()
      if (oldest.done) break
      fallbackSlots.delete(oldest.value)
    }
    return slot.expiresAt
  }
  const clearFallbackSlot = (installationKey: string | null | undefined): void => {
    fallbackSlots.delete(fallbackKeyOf(typeof installationKey === 'string' ? installationKey : null))
  }
  /**
   * 重跑一次合规版决议（#156）：`checkFallback` 的第一次决议与 `installCandidate` 的确认时复核
   * 走**同一段代码**——两处各写一套就是两套真源，复核会跟用户当面看见的那次决议分家。
   * 取时间表失败如实抛（调用方退通用老路，永不编造候选）；决议函数没注入即 `unsupported`。
   */
  async function resolveCompliantNow(decision: FallbackDecision): Promise<CompliantVerdict> {
    const resolve = ports.resolveCompliantVersion
    if (typeof resolve !== 'function') throw updateError('unsupported')
    const packument = await fetchPackumentTimes(ports.fetchImpl, checkTimeoutMs, {
      targetPackageName,
      registryUrl,
      emitLog: logPort ?? undefined,
      registryHost,
    })
    return resolve({
      kind: decision.kind,
      blame: 'target',
      targetVersion: decision.targetVersion ?? packument.latest,
      latestVersion: packument.latest,
      runningVersion: ports.readRunningVersion(),
      releaseChannel,
      windowMs: decision.windowMs,
      windowSource: decision.windowSource,
      publishedAtMs: decision.publishedAtMs,
      timeTable: packument.times,
      nowMs: ports.now(),
    })
  }
  let checking: Promise<CheckResult> | null = null
  let lastCheckAt = -Infinity
  let activeJobId: string | null = null
  // 已经记过中断换算的任务编号（#124）：落盘写不回去时防重复刷屏。
  const notedInterruptions = new Set<string>()
  let memJob: UpdateJob | null = null
  let memLock: string | null = null
  async function loadJob(): Promise<UpdateJob | null> {
    try {
      return ports.readJob ? ((await ports.readJob()) ?? null) : memJob
    } catch {
      throw updateError('install-failed')
    }
  }
  async function saveJob(job: UpdateJob | null): Promise<void> {
    try {
      if (ports.writeJob) await ports.writeJob(job)
      else memJob = job
    } catch {
      throw updateError('install-failed')
    }
  }
  async function acquire(lockId: string): Promise<boolean> {
    try {
      if (ports.tryAcquireLock) return await ports.tryAcquireLock(lockId)
    } catch {
      return false
    }
    if (memLock !== null) return false
    memLock = lockId
    return true
  }
  async function release(lockId: string): Promise<void> {
    try {
      if (ports.releaseLock) await ports.releaseLock(lockId)
      else if (memLock === lockId) memLock = null
    } catch {}
  }
  function healJob(job: UpdateJob | null, env: EnvironmentView): UpdateJob | null {
    if (!job) return null
    if (job.state === 'installing' || job.state === 'verifying') {
      return job.id === activeJobId ? job : { ...job, state: 'interrupted', message: 'recovery-required', requestId: job.requestId ?? null }
    }
    if (job.state === 'restart-required' || job.state === 'completed') {
      if (!job.targetVersion || env.installedVersion !== job.targetVersion) {
        return { ...job, state: 'interrupted', message: 'installation-changed', requestId: job.requestId ?? null }
      }
      const runningVersion = ports.readRunningVersion()
      return { ...job, state: runningVersion === job.targetVersion ? 'completed' : 'restart-required', requestId: job.requestId ?? null }
    }
    return job
  }

  function buildSnapshot(env: EnvironmentView, job: UpdateJob | null): UpdateSnapshot {
    // 在场事实优先（#134）：缺席分支在 newer / 通道 / Node 判定之前；`installed` 缺字段的老
    // 生产者按在场走（宽容读），只有显式 false 才算缺席。
    const present = env.installed !== false
    // 缺席时不采信 checked 的旧阻拦（A1/A2：stable 通道判定内联在这里算，永不进 checked；
    // Node 不兼容只记不拦，行仍可点，失败落装侧）。
    let blockedReason: BlockedReason | null = present ? (env.blockedReason ?? checked?.blockedReason ?? null) : (env.blockedReason ?? null)
    if (!present && blockedReason === null && checked?.release) {
      if (!isVersionAllowedInChannel(checked.release.version, releaseChannel)) blockedReason = 'channel-mismatch'
    }
    if (job?.state === 'interrupted' || job?.state === 'failed') {
      if (env.installedVersion !== ports.readRunningVersion()) blockedReason = 'recovery-required'
    } else if (job?.state === 'restart-required' || (env.installedVersion && env.installedVersion !== ports.readRunningVersion())) {
      blockedReason = 'pending-restart'
    }
    const busy = job?.state === 'installing' || job?.state === 'verifying'
    const fresh = checked !== null && checked.checkId !== null && ports.now() < checked.expiresAt
    const runningVersion = ports.readRunningVersion()
    // 通道门（#16）：stable 默认与旧行为一字不差（纯三段 + 数字比较）；
    // prerelease 通道下运行版与远端版都按发行版语义比（预发布 < 同号正式版）。
    // 缺席时不与注入的运行版号比大小（#137 硬要求 / US19）：只看远端版本是否存在、
    // 合法且被本通道接受，其余子句一字不动。
    let newer = false
    let remoteOk = false
    try {
      if (present) {
        newer =
          isVersionAllowedInChannel(runningVersion, releaseChannel) &&
          !!checked?.release &&
          isVersionAllowedInChannel(checked.release.version, releaseChannel) &&
          compareReleaseVersions(checked.release.version, runningVersion) === 1
      } else if (checked?.release) {
        remoteOk = isVersionAllowedInChannel(checked.release.version, releaseChannel)
      }
    } catch {
      newer = false
      remoteOk = false
    }
    const canInstall = Boolean(
      env.eligible &&
        !blockedReason &&
        !busy &&
        fresh &&
        checked?.installationKey === env.installationKey &&
        (present ? newer : remoteOk),
    )
    const snapshot: UpdateSnapshot = {
      runningVersion,
      installed: present,
      installedVersion: env.installedVersion ?? null,
      latestVersion: checked?.release.version ?? null,
      canInstall,
      blockedReason,
      job,
    }
    // 主状态边沿（#124）：快照每次算出来都对一次账，只有真的变了才落一行。
    noteStatusChanged(snapshot)
    return snapshot
  }

  /** 主状态三值（#124）：与快照「有没有新版」同一判据，不许出现第二套口径。 */
  function statusKindOf(snapshot: UpdateSnapshot): 'update-available' | 'up-to-date' | 'unknown' {
    if (!snapshot.latestVersion) return 'unknown'
    // 缺席时不拿远端版与注入的运行版号比大小（#134/US16）：有远端可装即 update-available，
    // 否则绝不谎称 up-to-date。
    if (snapshot.installed === false) return 'update-available'
    try {
      const newer =
        isVersionAllowedInChannel(snapshot.runningVersion, releaseChannel) &&
        isVersionAllowedInChannel(snapshot.latestVersion, releaseChannel) &&
        compareReleaseVersions(snapshot.latestVersion, snapshot.runningVersion) === 1
      return newer ? 'update-available' : 'up-to-date'
    } catch {
      return 'unknown'
    }
  }
  let lastStatusKind: string | null = null
  /**
   * `update.status.changed` 的唯一落点（#124）：常驻行的铁律是边沿触发，所以状态没变就一条不发；
   * 变了就强制落（`always`）——发射口的去重记忆按事件名走，多插件同进程会互相压，本处自己把关。
   */
  function noteStatusChanged(snapshot: UpdateSnapshot): void {
    const kind = statusKindOf(snapshot)
    if (kind === lastStatusKind) return
    lastStatusKind = kind
    emit(
      'info',
      'update.status.changed',
      { kind, ...(snapshot.latestVersion ? { latest: snapshot.latestVersion } : {}) },
      { always: true },
    )
  }

  /**
   * 通道判定（#124）：一次成功检查落一行。四值是相互排斥的判定结果，不是自由文本：
   * 版本形状都不像版本 → `invalid`；形状像但有一条不被本通道接受 → `mismatch`；都收 → 本通道名。
   */
  function noteChannelDecision(current: string, latest: string): void {
    const shapeOk = validVersion(current) && validVersion(latest)
    let reason: 'stable' | 'prerelease' | 'mismatch' | 'invalid'
    if (!shapeOk) reason = 'invalid'
    else if (!isVersionAllowedInChannel(current, releaseChannel) || !isVersionAllowedInChannel(latest, releaseChannel)) {
      reason = 'mismatch'
    } else reason = releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
    emit('info', 'update.channel.decide', { channel: releaseChannel, reason, from: current, to: latest })
  }

  function jobsEqual(a: UpdateJob | null, b: UpdateJob | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.id === b.id && a.state === b.state && a.targetVersion === b.targetVersion && a.message === b.message && (a.requestId ?? null) === (b.requestId ?? null)
  }
  async function healedJob(env: EnvironmentView): Promise<UpdateJob | null> {
    const loaded = await loadJob()
    const healed = healJob(loaded, env)
    if (!jobsEqual(loaded, healed)) {
      try {
        await saveJob(healed)
      } catch {
        // 只读回查的落盘是 best-effort：写不回去仍按换算后的快照展示，不把状态读数变成安装失败。
      }
      // 中断换算（#124）：只有这次读回**才**把任务从活状态换成 `interrupted` 时记一条。
      // 落盘是 best-effort：写不回去时每次读回都会重现同一个换算，所以按任务编号去重，不刷屏。
      if (healed && healed.state === 'interrupted' && loaded && loaded.state !== 'interrupted' && !notedInterruptions.has(healed.id)) {
        notedInterruptions.add(healed.id)
        emit('info', 'update.install.verify', {
          result: 'interrupted',
          ...(env.installedVersion ? { installedVersion: env.installedVersion } : {}),
          pendingRestart: false,
        })
      }
    }
    return healed
  }
  async function status(): Promise<UpdateSnapshot> {
    const t0 = Date.now()
    const env = await ports.readInstalled()
    const job = await healedJob(env)
    const snapshot = buildSnapshot(env, job)
    // `update.poll`（#124，ondemand 档）：这一支就是每秒轮询走的入口。开关没开时发射口直接丢，
    // 不占预算；`state` 用主状态三值，与 `update.status.changed` 同一口径（排查「为什么一直在轮询」用）。
    emit('info', 'update.poll', { state: statusKindOf(snapshot), latencyMs: Math.max(0, Date.now() - t0) })
    return snapshot
  }

  async function check(trigger?: unknown): Promise<CheckResult> {
    if (checking) return checking
    // 2 秒内重复点击复用上次结果，不重新联网（失败不缓存为成功）。
    if (checked?.checkId && ports.now() - lastCheckAt < RECHECK_WINDOW_MS) {
      const env = await ports.readInstalled()
      const snapshot = buildSnapshot(env, await healedJob(env))
      return { snapshot, receipt: snapshot.canInstall ? toReceipt() : null }
    }
    lastCheckAt = ports.now()
    const startedAt = Date.now()
    // `update.check.start`（#124，ondemand 档）：只在调用方自报了触发方时落一条。
    const askedBy = triggerOf(trigger)
    if (askedBy) {
      emit('info', 'update.check.start', {
        trigger: askedBy,
        ...(registryHost ? { source: registryHost } : {}),
      })
    }
    checking = (async () => {
      try {
        const env = await ports.readInstalled()
        // #183：通道不符只在「已装版本本身就不在本通道（或压根未装）」时容忍。这时整次检查
        // 在修复前会直接 check-failed，可真正的结论（channel-mismatch）读取器早就算出来了，
        // 缺省 stable 遇到 latest 是预发布时用户只能看到「检查失败」。已装版本在通道内、只有
        // 远端最新是预发布的那一支仍按旧样失败：不取 packument 就分不清「只有预发布更新」
        // 与「取数真坏了」，宁可大声失败，也不把它悄悄画成「已是最新」。
        const installedOutOfChannel =
          env.installed === false || !isVersionAllowedInChannel(env.installedVersion ?? '', releaseChannel)
        const release = await fetchRelease(installedOutOfChannel)
        checked = {
          release,
          checkId: ports.randomId(),
          checkedAt: ports.now(),
          expiresAt: ports.now() + confirmationTtlMs,
          installationKey: env.installationKey,
          blockedReason: satisfiesNodeRange(ports.nodeVersion, release.nodeRange) ? null : 'incompatible-node',
        }
        // 新检查结论落地，旧候选即失效（#156）：latest 变了，基于旧 latest 的决议不许再用。
        // 只清同一安装指纹的槽：清全部会把别家的候选一起抹掉（批量逐家检查即互踩）。
        clearFallbackSlot(env.installationKey)
        // 凭证只在能装时交：没新版或有阻拦时交了也没用，不交。
        const snapshot = buildSnapshot(env, await healedJob(env))
        // 通道判定与检查成功各一条（#124）：顺序是先判定再宣布成功，读日志的人先看到「为什么」。
        noteChannelDecision(snapshot.runningVersion, release.version)
        emit('info', 'update.check.done', {
          ok: true,
          current: snapshot.runningVersion,
          latest: release.version,
          channel: releaseChannel,
          ...(registryHost ? { source: registryHost } : {}),
          latencyMs: Math.max(0, Date.now() - startedAt),
        })
        return { snapshot, receipt: snapshot.canInstall ? toReceipt() : null }
      } catch (error) {
        if (checked) checked = { ...checked, checkId: null, expiresAt: 0 }
        const httpStatus = httpStatusOfError(error)
        emit('warn', 'update.check.fail', {
          stage: stageOfError(error),
          errorKind: stableCodeOf(error),
          ...(httpStatus === null ? {} : { httpStatus }),
        })
        throw error
      } finally {
        checking = null
      }
    })()
    return checking
  }

  function toReceipt(): CheckResult['receipt'] {
    if (!checked?.checkId) return null
    // 凭证只交编号与有效期：环境指纹留在核心内存里，快照与凭证都不带它。
    return { checkId: checked.checkId, checkedAt: checked.checkedAt, expiresAt: checked.expiresAt }
  }

  /**
   * 合规版决议（#156）：年龄门拦住时问一次。先做三道免取数早退（缺窗口/非主包/
   * 未知 kind——连评都评不了，不花一次联网），再取时间表做纯决议；有候选才取
   * 候选版本文档做完整性校验并落第二槽凭证。取数失败诚实抛（调用方退通用老路），
   * 永不编造候选；决议函数没注入即 `unsupported`（与 `runInstall` 缺席同口径）。
   */
  async function checkFallback(input: FallbackCheckInput): Promise<FallbackCheckResult> {
    const kind = typeof input?.kind === 'string' && input.kind ? input.kind : 'minimum-release-age'
    const blame = input?.blame === 'target' ? 'target' : input?.blame === 'other-package' ? 'other-package' : 'unknown'
    const windowSource = input?.windowSource === 'message' || input?.windowSource === 'host' ? input.windowSource : 'unknown'
    const windowMs = typeof input?.windowMs === 'number' && Number.isFinite(input.windowMs) && input.windowMs > 0 ? input.windowMs : null
    const publishedAtMs = typeof input?.publishedAtMs === 'number' && Number.isFinite(input.publishedAtMs) && input.publishedAtMs > 0 ? input.publishedAtMs : null
    const targetVersion = typeof input?.targetVersion === 'string' && input.targetVersion ? input.targetVersion : null
    // 三道免取数早退：输入不可用即 abstain，不花一次联网（B 类天然走这里）。
    const resolve = ports.resolveCompliantVersion
    if (typeof resolve !== 'function') throw updateError('unsupported')
    if (windowMs === null) {
      // 评都评不了：本实例没有可用候选。别家的槽不按"猜的键"清（B2 教训），只等它自己到期。
      clearFallbackSlot(null)
      return { verdict: resolve({ kind, blame, targetVersion: targetVersion ?? '', latestVersion: '', runningVersion: '', windowMs: null, windowSource, publishedAtMs, timeTable: {}, nowMs: ports.now() }), candidate: null, receipt: null }
    }
    if (blame !== 'target') {
      clearFallbackSlot(null)
      return { verdict: { kind: 'abstain', reason: 'not-target', windowSource }, candidate: null, receipt: null }
    }
    const decision: FallbackDecision = { kind, windowMs, windowSource, publishedAtMs, targetVersion }
    const verdict = await resolveCompliantNow(decision)
    // 两种候选都算数（#156 M2）：`downgrade-available`＝最新版还被门挡着、有满门限的老版可装；
    // `ok-now`＝门限已经过了、**最新版现在就能装**（决议点名的那一版就是最新版）。两种都给凭证、
    // 都点名版本；三入口本就认这两种（`vKind === 'ok-now'` 分支），从前只有服务侧不给 ok-now 发
    // 凭证，于是最该说"现在直接装最新版"的时刻反而只弹"不可用"——同一下普通重试却能成功。
    if (verdict.kind !== 'downgrade-available' && verdict.kind !== 'ok-now') {
      clearFallbackSlot(null)
      return { verdict, candidate: null, receipt: null }
    }
    // 有候选才做版本文档校验（与 latest 同一套 tarball/integrity 形状门，不过即 invalid-release）。
    const env = await ports.readInstalled()
    const release = await fetchNpmVersionRelease(ports.fetchImpl, checkTimeoutMs, {
      targetPackageName,
      registryUrl,
      releaseChannel,
      version: verdict.version,
      emitLog: logPort ?? undefined,
      registryHost,
    })
    const checkId = ports.randomId()
    const checkedAt = ports.now()
    const expiresAt = writeFallbackSlot({
      version: verdict.version,
      release,
      checkId,
      checkedAt,
      expiresAt: checkedAt + confirmationTtlMs,
      installationKey: env.installationKey,
      decision,
    })
    return { verdict, candidate: verdict.version, receipt: { checkId, checkedAt, expiresAt } }
  }

  async function runBackground(job: UpdateJob, envAtStart: EnvironmentView): Promise<void> {
    // 装后校验读到的环境（#124）：失败分支也要如实记「磁盘上是什么版本」。
    let verifiedEnv: EnvironmentView | null = null
    try {
      if (ports.runInstall) await ports.runInstall({ version: job.targetVersion as string, profileName: envAtStart.profileName, environmentKind: envAtStart.environmentKind, releaseChannel })
      // 字面量不另存一份真源：`satisfies UpdateErrorCode` 把它钉在 src/codes.ts 的类型上，
      // 真源删/改这个码这里立刻 typecheck 报错；而本文件「零（运行时）导入」的契约不受影响。
      else throw updateError('unsupported' satisfies UpdateErrorCode)
      const doing: UpdateJob = { ...job, state: 'verifying', message: null }
      activeJobId = doing.id
      await saveJob(doing)
      const env = await ports.readInstalled()
      verifiedEnv = env
      // 装完校验也会失败：它同样要给出一句能读的说明，不能只留一个死码（验收判据 1）。
      if (env.installedVersion !== job.targetVersion) {
        throw Object.assign(updateError('install-failed'), {
          detail: `装完校验没过：磁盘上是 ${env.installedVersion ?? '未知'}，目标是 ${job.targetVersion ?? '未知'}`,
        })
      }
      // 在册核实（#180；#201 起改成「登记不许倒退」）：新装必须登记，否则重启后插件根本不会加载；
      // 但更新一个**装前就没登记**的包时，唯一可用的通道是就地换版（宿主 removeBundle 卸不掉未选中的
      // bundle，见 #201），更新后仍未登记不是这次安装造成的——拿它判失败等于让这类包永远升不了级。
      // 装前登记过、装后却没了的半装态仍然大声失败（宿主两步配方只落一半的典型形态）。
      const registrationWasMissing = envAtStart.installed === true && envAtStart.registered === false
      if (env.registered === false && !registrationWasMissing) {
        throw Object.assign(updateError('install-failed'), {
          detail: '装完校验没过：profile 未登记该插件（重启后不会加载）',
        })
      }
      if (env.blockedReason && env.blockedReason !== 'pending-restart') {
        throw Object.assign(updateError('install-failed'), { detail: `装完校验没过：环境报告 ${env.blockedReason}` })
      }
      const done: UpdateJob = { ...doing, state: 'restart-required', message: null }
      await saveJob(done)
      // 装后校验（#124）：磁盘版本与目标一致才算过；要不要重启按运行版判定——
      // 运行版还没换过来就是 `restart-required`，已经换过来了就是 `completed`。
      const pendingRestart = ports.readRunningVersion() !== job.targetVersion
      emit('info', 'update.install.verify', {
        result: pendingRestart ? 'restart-required' : 'completed',
        ...(env.installedVersion ? { installedVersion: env.installedVersion } : {}),
        pendingRestart,
      })
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      const base =
        code === 'installation-changed' || code === 'registry-conflict' || code === 'install-failed' ? String(code) : 'install-failed'
      // 失败详情（宿主原话，执行器已截断脱敏）补进已有的 message 通道：值从纯 code 变成
      // 「code: 原话」，字段集与形状不变。消费方要匹配就匹配前缀 code，别做整串相等（README 第 12 节）。
      const detail = (error as { detail?: unknown })?.detail
      const message = typeof detail === 'string' && detail ? `${base}: ${detail}` : base
      const failedJob: UpdateJob = { ...job, state: 'failed', message, requestId: job.requestId ?? null }
      try {
        await saveJob(failedJob)
      } catch {
        memJob = failedJob
      }
      // 安装或装后校验失败（#124）：`result:'failed'`；磁盘上读到什么版本就记什么，读不到省这一格。
      emit('info', 'update.install.verify', {
        result: 'failed',
        ...(verifiedEnv?.installedVersion ? { installedVersion: verifiedEnv.installedVersion } : {}),
        pendingRestart: false,
      })
    } finally {
      await release(job.id)
      if (activeJobId === job.id) activeJobId = null
    }
  }

  /**
   * 前版本保真（#186）：动手前记下磁盘上的版本（未安装或读不到即 null，不拿运行版顶替），
   * 供 before.json 与恢复诊断对照。两条安装入口共用，免得动作分叉。
   */
  function rememberPreviousVersion(job: UpdateJob, env: EnvironmentView): void {
    job.previousVersion = env.installedVersion ?? null
  }

  /**
   * 候选安装（#156）：把用户点"装合规版"的意图落成任务。门与 latest 路径同口径：
   * 绑定（槽×版本×凭证×有效期）、指纹、忙、环境、运行版比较——门名一个不新增，
   * 失败码仍是旧四码（check-expired/installation-changed/update-busy/环境阻拦），
   * 面板旧分支照单全收。装后校验走同一 `runBackground`（磁盘版与目标不一致即失败，
   * 回执校验是现货，不用新造）。
   */
  async function installCandidate(
    version: string,
    ctx: { checkId: string; requestId: string; from?: InstallSource; env: EnvironmentView; previous: UpdateJob | null },
  ): Promise<UpdateSnapshot> {
    const slot = readFallbackSlot(ctx.env.installationKey)
    // 绑定三件套：槽要有、版本要对上、凭证编号要对上、没过期——缺一即检查过期，不猜。
    if (!slot || slot.version !== version || !slot.checkId || slot.checkId !== ctx.checkId || ports.now() >= slot.expiresAt) {
      throw updateError('check-expired')
    }
    // 空更新哨兵（#202）：目标与磁盘已装版相同即无需安装，先于指纹/环境闸门给结论。
    refuseNoopInstall(version, ctx.env)
    if (ctx.env.installationKey !== slot.installationKey) throw updateError('installation-changed')
    if (!ctx.env.eligible || ctx.env.blockedReason) throw updateError(ctx.env.blockedReason ?? 'update-busy')
    const runningVersion = ports.readRunningVersion()
    // 候选必须严格新于运行版（决议时验过，这里再验一次：环境可能在决议后前进了）。
    if (!validReleaseVersion(runningVersion) || compareReleaseVersions(version, runningVersion) !== 1) {
      throw updateError('installation-changed')
    }
    // 用户意图（#124）：字段与 latest 路径同名同口径，latest 格填的是这次真要装的版本，不新增键。
    emit('info', 'update.install.request', {
      from: installSourceOf(ctx.from),
      current: runningVersion,
      latest: version,
      checkAgeMs: Math.max(0, ports.now() - slot.checkedAt),
    })
    const job: UpdateJob = {
      id: ports.randomId(),
      state: 'installing',
      targetVersion: version,
      message: null,
      requestId: ctx.requestId,
    }
    if (!(await acquire(job.id))) throw updateError('update-busy')
    try {
      // 确认时复核（#156 M3）：拿**同一批输入**重跑一次决议。凭证最长活十分钟，这期间门限会过期、
      // 新版会发布；"当时可装"不等于"现在还是最新可装"。候选变了（或已不再可装）即 check-expired，
      // 交 UI 重新决议——按钮点名的那个版本永不偷偷换掉，用户确认的也不是一个过时的"当时最新"。
      const fresh = await resolveCompliantNow(slot.decision)
      const usable = fresh.kind === 'downgrade-available' || fresh.kind === 'ok-now' ? fresh.version : null
      if (usable !== version) throw updateError('check-expired')
      // 装前复核（与 latest 路径同纪律）：候选版本文档重取一次，对不上决议时存的即过期。
      const current = await fetchNpmVersionRelease(ports.fetchImpl, checkTimeoutMs, {
        targetPackageName,
        registryUrl,
        releaseChannel,
        version,
        emitLog: logPort ?? undefined,
        registryHost,
      })
      if (JSON.stringify(current) !== JSON.stringify(slot.release)) throw updateError('check-expired')
      const env = await ports.readInstalled()
      if (env.installationKey !== slot.installationKey) throw updateError('installation-changed')
      if (!env.eligible || env.blockedReason) throw updateError(env.blockedReason ?? 'update-busy')
      // 空更新哨兵（#202）：重取环境后目标与磁盘已装版相同即不再动手。
      refuseNoopInstall(version, env)
      // 前版本保真（#186）：记下「动手之前」磁盘上的版本，供 before.json 与恢复诊断对照。
      rememberPreviousVersion(job, env)
      if (ports.backupJob) await ports.backupJob(job)
      await saveJob(job)
      activeJobId = job.id
      // 落盘后后台跑，调用方不干等：每秒轮询查状态即可看到进度，关页面不取消。
      void runBackground(job, env).catch(() => {})
      return buildSnapshot(env, job)
    } catch (error) {
      await release(job.id)
      throw error
    }
  }

  /**
   * 空更新哨兵（#202）：批量编排在「查不到运行版」时会把「已装版」当目标再发起一次安装
   * （真机 20:03 那五行就是 target 与已装版相同，2–6ms 被宿主拒绝或白跑两步）。
   * 目标与磁盘已装版完全相同时不启动安装：没有要换的版本，装完读到的还是它。
   * 只挡相等——合规降级路径的目标本来就低于磁盘版，那是另一条合法意图（#156）。
   */
  function refuseNoopInstall(targetVersion: string, env: EnvironmentView): void {
    if (env.installed !== true || typeof env.installedVersion !== 'string') return
    if (compareReleaseVersions(targetVersion, env.installedVersion) !== 0) return
    throw Object.assign(updateError('installation-changed'), {
      detail: '目标版本与已装版本相同，无需安装',
    })
  }

  async function install(args: { checkId: string; requestId: string; from?: InstallSource; version?: string }): Promise<UpdateSnapshot> {
    const checkId = typeof args?.checkId === 'string' ? args.checkId : ''
    const requestId = typeof args?.requestId === 'string' ? args.requestId : ''
    if (!checkId || !validRequestId(requestId)) throw updateError('check-expired')
    let env = await ports.readInstalled()
    let previous = healJob(await loadJob(), env)
    // 同一个请求编号重复提交直接返回旧结果，不重装。
    if (previous?.requestId === requestId) return buildSnapshot(env, previous)
    if (previous?.state === 'installing' || previous?.state === 'verifying' || previous?.state === 'restart-required') {
      throw updateError('update-busy')
    }
    // 候选分支（#156）：指定装合规版——只认第二槽绑定，不认任意旧版；
    // 凭证、指纹、忙、环境四道门与 latest 路径同口径，门名不变。
    const wantedVersion = typeof args?.version === 'string' && args.version ? args.version : null
    if (wantedVersion) return installCandidate(wantedVersion, { checkId, requestId, from: args?.from, env, previous })
    if (!checked || !checked.checkId || checked.checkId !== checkId || ports.now() >= checked.expiresAt) {
      throw updateError('check-expired')
    }
    // 空更新哨兵（#202）：目标与磁盘已装版相同就到此为止，不建作业、不惊动静默状态机。
    // 放在安装指纹/环境闸门之前：这类请求的「错」不是安装位置变了、也不是恢复待重启，而是根本没东西可装。
    refuseNoopInstall(checked.release.version, env)
    if (env.installationKey !== checked.installationKey) throw updateError('installation-changed')
    const snap = buildSnapshot(env, previous)
    if (!snap.canInstall) {
      // 查失败不准抛 update-busy（#136-A1）：缺席且无他因时按过期检查诚实失败；
      // 在场路径保持旧行为（一字不动）。
      if (!snap.installed) throw updateError(snap.blockedReason ?? checked.blockedReason ?? 'check-expired')
      throw updateError(env.blockedReason ?? checked.blockedReason ?? 'update-busy')
    }
    // 用户意图（#124）：过完所有闸门、真的要装了才落这一条；被闸门挡掉的请求不算一次意图。
    emit('info', 'update.install.request', {
      from: installSourceOf(args?.from),
      current: ports.readRunningVersion(),
      latest: checked.release.version,
      checkAgeMs: Math.max(0, ports.now() - checked.checkedAt),
    })
    const job: UpdateJob = {
      id: ports.randomId(),
      state: 'installing',
      targetVersion: checked.release.version,
      message: null,
      requestId,
    }
    if (!(await acquire(job.id))) throw updateError('update-busy')
    try {
      const current = await fetchRelease()
      if (JSON.stringify(current) !== JSON.stringify(checked.release)) throw updateError('check-expired')
      env = await ports.readInstalled()
      if (env.installationKey !== checked.installationKey) throw updateError('installation-changed')
      if (!env.eligible || env.blockedReason) throw updateError(env.blockedReason ?? 'update-busy')
      // 前版本保真（#186）：记下「动手之前」磁盘上的版本，供 before.json 与恢复诊断对照。
      rememberPreviousVersion(job, env)
      if (ports.backupJob) await ports.backupJob(job)
      await saveJob(job)
      activeJobId = job.id
    } catch (error) {
      await release(job.id)
      throw error
    }
    // 落盘后后台跑，调用方不干等：每秒轮询查状态即可看到进度，关页面不取消。
    void runBackground(job, env).catch(() => {})
    return buildSnapshot(env, job)
  }

  return { status, check, install, checkFallback }
}
