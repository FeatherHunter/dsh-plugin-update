// src/host/capabilities.ts —— 宿主能力装配（#227 从 host.ts 搬出，蓝图 §4 host 域）。
//
// 管两件事：① ReaderOverrides（调用方注入端口的唯一形状，风险 R2）；
// ② 单例读取器装配 getSharedReader：解析使用范围 → 磁盘/队列/锁/执行器端口 → 读取器（含跨插件队列口）。
// 单例状态只在本模块：sharedReader / sharedReaderKey；复位口 resetSharedUpdateReaderState 给测试。

import {
  ctxService,
  nonEmptyText,
  profileIdentityFromContext,
  profileIdentityFromEnv,
  tryInferProfileDir,
  unknownProfile,
  devSource,
  detectEnvironmentKind,
  sharedDesktopService,
} from './environment.js'

import { homedir } from 'node:os'
import { resolveUpdateConfig } from '../shared/config.js'
import { emitUpdateLog } from '../log/emit.js'
import { validReleaseVersion } from '../core/service.js'
import { createUpdateDiskPorts } from '../core/disk.js'
import { createUpdateExecutor } from '../core/executor.js'
import { createUpdateQueuePorts } from '../core/queue/ports.js'
import { createUpdateReader, defaultHomeDir, resolveProfileName, resolveTargetPackage } from '../core/reader.js'
import { resolveRegistryHost } from '../shared/redaction.js'
import type { EnvironmentKind, ReleaseChannel, UpdateLogPort } from '../shared/ports.js'
import {
  QUEUE_INTENT_TTL_MS,
  emptyQueueState,
  normalizeQueueState,
  pruneExpiredIntents,
  releaseOwnerInQueue,
  setOwnerIfFree,
  type UpdateQueueState,
} from '../core/queue/model.js'

// 单例让查状态看到查新版的结果；复用键强制含插件标识（规格 #591 第 6 条），多插件不串内存。
// 跨插件队列读写口（#15）随单例一起缓存，与本次解析出的使用范围绑定。
type SharedQueueIO = {
  readQueuePruned(): Promise<UpdateQueueState>
  writeQueueState(state: UpdateQueueState): Promise<void>
  queueTtlMs: number
  queueNow(): number
}
let sharedReader: (ReturnType<typeof createUpdateReader> & SharedQueueIO) | null = null
let sharedReaderKey = ''
export interface ReaderOverrides {
  env?: Record<string, string | undefined>
  osHome?: string
  /**
   * 运行版本（宿主自带清单）。**未知请显式传 `null`**（#182）——不要伪造 `0.0.0`：
   * 未知不参与比较、不落事件 `current`、面板按未知呈现。不传则回落到读宿主清单。
   */
  runningVersion?: string | null
  /**
   * 当前 DSH 运行时版本（#195，可选）：未知时不传或传 `null`/空串。
   * 检查层只在拿得到时提前判远端 `engines.dsh` 要求；拿不到就不猜、不误拦。
   */
  dshVersion?: string | null
  profileDir?: string
  profileName?: string | null
  homeDir?: string
  environmentKind?: EnvironmentKind
  ctx?: unknown
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<never>
  now?: () => number
  /**
   * 编号发生器（测试与特殊宿主可换）。
   * **契约：同一个使用范围（同一队列文件）内，注入值必须全局唯一** —— 队列的拥有者账本按
   * (pluginId, jobId) 认人；若给多个目标注入同一个编号，会被记串（#27 里一个夹具就这么撞过）。
   * 生产走 randomUUID，不会撞；写测试夹具时请按目标派生（如 'id-' + key + '-' + n）。
   */
  randomId?: () => string
  nodeVersion?: string
  targetPackageName?: string
  registryUrl?: string
  checkTimeoutMs?: number
  confirmationTtlMs?: number
  installTimeoutMs?: number
  /** 版本通道：默认走配置的通道，显式覆盖供测试与特殊宿主用（#16）。 */
  releaseChannel?: ReleaseChannel
  /** 队列意向有效期毫秒：默认 10 分钟（#15），须为有限大于 0 的数才生效，否则走默认。 */
  queueTtlMs?: number
  /** 跨插件队列的显式假件（测试用；给了 readQueue + writeQueue 即不走真实队列目录，#15）。 */
  readQueue?: () => UpdateQueueState | Promise<UpdateQueueState>
  writeQueue?: (state: UpdateQueueState) => void | Promise<void>
  /**
   * 抢全局锁的显式覆盖（测试与特殊宿主用）。
   * 第三参是**锁陈旧判据的时限**，与安装时限同源——阈值只由这一处决定，别再让覆盖实现自己拍一个；
   * 不接这个参数的旧实现行为一字不变（TS 允许少接参数）。
   */
  tryAcquireGlobalLock?: (lockId: string, pluginId: string, opts?: { timeoutMs?: number }) => boolean | Promise<boolean>
  releaseGlobalLock?: (lockId: string) => void | Promise<void>
  readInstalled?: () => Promise<import('../shared/ports.js').EnvironmentView>
  readJob?: () => Promise<import('../shared/ports.js').UpdateJob | null>
  writeJob?: (job: import('../shared/ports.js').UpdateJob | null) => Promise<void>
  tryAcquireLock?: (lockId: string) => boolean | Promise<boolean>
  releaseLock?: (lockId: string) => void | Promise<void>
  backupJob?: (job: import('../shared/ports.js').UpdateJob) => void | Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runInstall?: (args: {
    version: string
    profileName: string | null
    environmentKind: EnvironmentKind
    releaseChannel?: ReleaseChannel
    approvedBuilds?: string[]
  }) => any
  subprocess?: unknown
  desktopPnpm?: unknown
  desktopProfiles?: unknown
  /** 官方桌面版进程内的插件管理器（显式覆盖用；不传就从 ctx 现取）。 */
  pluginManager?: unknown
  runtimeExecutable?: string
  runtimeExecArgs?: string[]
  cliEntry?: string
  /** 显式目标包目录：优先于按包名自动解析（hoisted、多副本、开发态链接等场景的逃生口）。 */
  targetPackageDir?: string
}
export async function getSharedReader(pluginId: string, config: ReturnType<typeof resolveUpdateConfig>, overrides: ReaderOverrides = {}): Promise<ReturnType<typeof createUpdateReader> & SharedQueueIO> {
  const env = overrides.env ?? process.env
  const osHome = overrides.osHome ?? homedir()
  const homeDirDefault = defaultHomeDir(env, osHome)
  const targetPackageName = overrides.targetPackageName ?? config.targetPackageName
  const releaseChannel: ReleaseChannel = overrides.releaseChannel ?? config.releaseChannel ?? 'stable'
  const explicitTargetDir =
    typeof overrides.targetPackageDir === 'string' && overrides.targetPackageDir ? String(overrides.targetPackageDir) : ''
  // 与读取器共用同一个解析函数（issue #3）：显式目录优先，否则按包名解析。
  const loaded = await resolveTargetPackage(targetPackageName, explicitTargetDir ? { targetPackageDir: explicitTargetDir } : {}).catch(
    () => null
  )
  // 运行版本只认“是不是合法发行版”，通道政策不在这里门控（issue #98）：
  // 定位得到但版本不被通道接受 → 照常建成读取器，阻拦由 readInstalled 的
  // channel-mismatch 分支诚实报告；unknown-profile 只留给“定位不到”。
  // #182：运行版本「未知」是一等状态——显式 null/空串即未知；不传才回落到宿主清单。
  const loadedVersion = loaded ? (loaded.manifest as { version?: unknown }).version : null
  const overrideVersion = overrides.runningVersion
  let runningVersion: string | null = null
  if (overrideVersion === null || overrideVersion === '') {
    runningVersion = null
  } else if (overrideVersion !== undefined) {
    // 显式覆盖即调用方责任，原样采用、有效性门不过问（与改造前一致）。
    runningVersion = overrideVersion
  } else if (validReleaseVersion(loadedVersion)) {
    runningVersion = String(loadedVersion)
  }
  const rawDshVersion = overrides.dshVersion
  const dshVersion: string | null = typeof rawDshVersion === 'string' && rawDshVersion.trim() ? rawDshVersion.trim() : null
  // #204：profile 身份优先用宿主给的权威来源，不再只靠目标包目录反推。
  // 顺序：显式覆盖 → ctx.profileContext（DSH 权威）→ desktopProfiles.current（第三方 Desktop）
  //      → 显式 env.DSH_PROFILE_DIR/DSH_PROFILE（集成方注入）→ 从目标包反推（旧兜底）。
  // 只有在「没有权威来源、也反推不到」的嵌入场景，才保留 #3/#153 的诚实失败语义。
  const explicitProfileName = nonEmptyText(overrides.profileName)
  const contextIdentity = profileIdentityFromContext(overrides)
  const envIdentity = profileIdentityFromEnv(overrides)
  let profileDirInput: string
  let profileNameInput: string | undefined
  if (overrides.profileDir) {
    profileDirInput = String(overrides.profileDir)
    profileNameInput = explicitProfileName || undefined
  } else if (contextIdentity) {
    profileDirInput = contextIdentity.dir
    profileNameInput = explicitProfileName || contextIdentity.name || undefined
  } else if (envIdentity) {
    profileDirInput = envIdentity.dir
    profileNameInput = explicitProfileName || envIdentity.name || undefined
  } else {
    const anchorDir = (loaded && loaded.directory ? String(loaded.directory) : '') || explicitTargetDir
    const inferred = anchorDir ? await tryInferProfileDir(anchorDir, targetPackageName) : null
    // 诚实失败（issue #3）：目标包定位不到且调用方没给 profileDir / targetPackageDir 时，
    // 不再猜 profiles/web（多范围并存即读错），也不再往下产出假的 installation-changed。
    // #153：包真实定位到（loaded != null）但反推不到范围（junction/显式外部目录）→ dev-source；
    // 判别式必须锚在 loaded 而非 anchorDir：显式目录指错/不存在时 loaded 为 null，
    // 此时真相是“指的地方没这个包”，仍报 unknown-profile，不许谎称开发态挂载。
    const located = !!(loaded && loaded.directory)
    if (!inferred) throw (located ? devSource() : unknownProfile())
    profileDirInput = inferred
    profileNameInput = explicitProfileName || undefined
  }
  const homeDirInput = overrides.homeDir ?? config.homeDir ?? homeDirDefault
  const environmentKind =
    overrides.environmentKind ?? detectEnvironmentKind(overrides.ctx, resolveProfileName(profileNameInput, profileDirInput))
  const checkTimeoutMs = overrides.checkTimeoutMs ?? config.checkTimeoutMs
  const confirmationTtlMs = overrides.confirmationTtlMs ?? config.confirmationTtlMs
  const installTimeoutMs = overrides.installTimeoutMs ?? config.installTimeoutMs
  const registryUrl = overrides.registryUrl ?? config.registryUrl
  const key = `${pluginId}\0${config.prefix}\0${runningVersion}\0${dshVersion}\0${profileDirInput}\0${profileNameInput ?? ''}\0${homeDirInput}\0${overrides.runInstall ? 'exec' : ''}\0${environmentKind}\0${targetPackageName}\0${explicitTargetDir}\0${releaseChannel}`
  if (sharedReader && sharedReaderKey === key) return sharedReader
  // 绑好插件标识的发射口（#124）：中立文件不 import node、也不认识插件标识，端口一律在宿主侧绑好再递进去。
  // 磁盘侧就是本插件这一家；队列与全局锁是**跨插件共享**的，所以给一个「按当次动作方取口」的工厂——
  // 一次跃迁记在谁头上，行就落谁自己的目录（路由表按标识寻址，别的插件没接线就只能没有落点，不猜）。
  const logPortFor = (id: string): UpdateLogPort => (level, event, fields, opts) => {
    emitUpdateLog(level, event, fields, { ...opts, pluginId: id })
  }
  const disk =
    overrides.readJob && overrides.writeJob
      ? null
      : createUpdateDiskPorts(homeDirInput, pluginId, profileDirInput, { log: logPortFor(pluginId) })
  // 跨插件单队列（#15）：与插件标识无关，按使用范围共享。显式队列假件优先；有真实落盘
  // 才走真实队列目录；纯内存测试（磁盘被假件替代）默认不碰真实队列目录，免得单测写脏真机。
  // 队列自身永远 best-effort：读不到按空队放行，写失败吞掉——队列坏了不能挡安装。
  const queueTtlMs =
    typeof overrides.queueTtlMs === 'number' && Number.isFinite(overrides.queueTtlMs) && overrides.queueTtlMs > 0
      ? overrides.queueTtlMs
      : QUEUE_INTENT_TTL_MS
  // #209：队列跃迁判据（pruned/abandoned）必须与宿主的 prune 同口径——同一份 ttl、同一个时钟；
  // 否则同一份队列，宿主说「过期清理」而落盘层说「主动放弃」。
  const queueNow = overrides.now ?? Date.now
  const queueDisk =
    overrides.readQueue && overrides.writeQueue
      ? null
      : disk
        ? createUpdateQueuePorts(homeDirInput, profileDirInput, {
            logFor: logPortFor,
            ttlMs: queueTtlMs,
            nowImpl: queueNow,
          })
        : null
  async function readQueueBestEffort(): Promise<UpdateQueueState> {
    try {
      if (overrides.readQueue) return normalizeQueueState(await overrides.readQueue())
      if (queueDisk) return normalizeQueueState(await queueDisk.readQueue())
    } catch {}
    return emptyQueueState()
  }
  async function writeQueueBestEffort(state: UpdateQueueState): Promise<void> {
    try {
      if (overrides.writeQueue) await overrides.writeQueue(normalizeQueueState(state))
      else if (queueDisk) await queueDisk.writeQueue(state)
    } catch {}
  }
  async function loadQueuePruned(): Promise<UpdateQueueState> {
    const raw = await readQueueBestEffort()
    const pruned = pruneExpiredIntents(raw, queueNow(), queueTtlMs)
    if (pruned !== raw) await writeQueueBestEffort(pruned)
    return pruned
  }
  // 组合锁：先抢全局（跨插件一次只装一个），再抢自家；自家没抢到就把全局放了，不占着。
  // 无全局可用时退化为自家锁（与改造前一字不差，老单测走这条）。
  // #181：内置端口要吃到安装额度（陈旧阈值与安装时限同源），显式覆盖实现保持单参不变。
  const baseTryAcquire: ((lockId: string) => boolean | Promise<boolean>) | undefined = overrides.tryAcquireLock
    ? (lockId: string) => overrides.tryAcquireLock!(lockId)
    : disk
      ? (lockId: string) => disk.tryAcquireLock(lockId, { timeoutMs: installTimeoutMs })
      : undefined
  const baseRelease = overrides.releaseLock ?? disk?.releaseLock
  // 阈值单源：两条路（显式覆盖 / 内置端口）拿到**同一个** installTimeoutMs。
  // 覆盖实现不接第三参就还是它自己的口径（行为不变），接了就跟安装时限对齐——批量路径原先自己传 {}，
  // 陈旧阈值落回 QUEUE_LOCK_STALE_MS，改过 installTimeoutMs 就会与这条分叉（#26 照出来的）。
  const globalTryAcquire: ((lockId: string) => boolean | Promise<boolean>) | undefined = overrides.tryAcquireGlobalLock
    ? (lockId: string) => overrides.tryAcquireGlobalLock!(lockId, pluginId, { timeoutMs: installTimeoutMs })
    : queueDisk
      ? (lockId: string) => queueDisk.tryAcquireGlobalLock(lockId, pluginId, { timeoutMs: installTimeoutMs })
      : undefined
  const globalRelease: ((lockId: string) => void | Promise<void>) | undefined =
    overrides.releaseGlobalLock ?? queueDisk?.releaseGlobalLock
  async function combinedTryAcquire(lockId: string): Promise<boolean> {
    try {
      if (globalTryAcquire && !(await globalTryAcquire(lockId))) return false
      if (baseTryAcquire && !(await baseTryAcquire(lockId))) {
        if (globalRelease) {
          try {
            await globalRelease(lockId)
          } catch {}
        }
        return false
      }
      return true
    } catch {
      return false
    }
  }
  async function combinedRelease(lockId: string): Promise<void> {
    try {
      if (baseRelease) await baseRelease(lockId)
    } catch {}
    try {
      if (globalRelease) await globalRelease(lockId)
    } catch {}
    // 拥有者兜底：只清自己的牌（jobId 对上才清），终态正常走镜像已清，这里多半是空操作。
    try {
      const current = await readQueueBestEffort()
      const next = releaseOwnerInQueue(current, pluginId, lockId)
      if (next.released) await writeQueueBestEffort(next.state)
    } catch {}
  }
  // 任务落盘（#179）：以前这里只留内存镜像，进程一崩任务就没了——`recovery-required` 永不点亮，
  // 半装态还会被环境比较画成「待重启」。现在写镜像的同时写盘（无注入走真实磁盘端口），
  // 首次读任务时先尝试从盘上取回初值（冷启动/重启后的唯一真相）。
  // 磁盘写失败不挡安装：内存镜像仍是本次真值，store 侧已记 store.fail；落盘的失败语义由装后校验兜底。
  // 落盘只在「两侧都没注入」时启用：只注一侧时不混两套真相（写走注入、读走镜像）。
  const jobDisk = overrides.readJob || overrides.writeJob ? null : disk
  let memJobFallback: import('../shared/ports.js').UpdateJob | null = null
  let jobStoreSeeded = false
  async function mirroredWriteJob(job: import('../shared/ports.js').UpdateJob | null): Promise<void> {
    if (overrides.writeJob) {
      memJobFallback = job
      await overrides.writeJob(job)
    } else {
      memJobFallback = job
      jobStoreSeeded = true
      if (jobDisk) {
        try {
          await jobDisk.writeJob(job)
        } catch {}
      }
    }
    try {
      if (!job) return
      const current = await readQueueBestEffort()
      const pruned = pruneExpiredIntents(current, queueNow(), queueTtlMs)
      if (job.state === 'installing' || job.state === 'verifying') {
        let next = pruned
        if (next.owner && next.owner.jobId === job.id) {
          next = {
            version: 1 as const,
            owner: {
              ...next.owner,
              requestId: job.requestId ?? next.owner.requestId,
              targetVersion: job.targetVersion ?? next.owner.targetVersion,
            },
            waiting: next.waiting.filter((e) => !(e.pluginId === pluginId && (e.requestId ?? null) === (job.requestId ?? null))),
          }
        } else {
          // 陈旧拥有者回收：持有者早该收尾却没摘牌（崩溃/杀进程），后来者直接接管不等它；
          // 口径与全局锁一致（安装时限），未知年龄按可回收算。
          let base = next
          const age = queueNow() - (typeof base.owner?.startedAt === 'number' ? base.owner.startedAt : 0)
          if (base.owner && age > installTimeoutMs) base = { version: 1 as const, owner: null, waiting: base.waiting }
          next = setOwnerIfFree(base, {
            pluginId,
            jobId: job.id,
            requestId: job.requestId,
            targetVersion: job.targetVersion,
            startedAt: queueNow(),
          }).state
        }
        if (next !== pruned) await writeQueueBestEffort(next)
        else if (pruned !== current) await writeQueueBestEffort(pruned)
      } else {
        const released = releaseOwnerInQueue(pruned, pluginId, job.id)
        const out = released.released ? released.state : pruned
        if (out !== current) await writeQueueBestEffort(out)
      }
    } catch {}
  }
  async function mirroredReadJob(): Promise<import('../shared/ports.js').UpdateJob | null> {
    if (overrides.readJob) return (await overrides.readJob()) ?? null
    // 冷启动首次读盘取初值；读失败不写死空——下一次读还会再试，免得一次瞬时失败把本进程画成「无任务」。
    // 坏形状的收敛在 store.readJob 里（corrupt → interrupted / recovery-required），这里不另立判据。
    if (!jobStoreSeeded && !memJobFallback && jobDisk) {
      try {
        memJobFallback = await jobDisk.readJob()
        jobStoreSeeded = true
      } catch {}
    }
    return memJobFallback
  }
  // 执行零件按需现取（桌面服务要等注入到位）：路由与参数形态由核心的 installRecipe 定，
  // 这里只提供「用哪个可执行文件、哪份 CLI 入口、哪条子进程口子」。
  const defaultRun = createUpdateExecutor({
    profileName: profileNameInput ?? null,
    environmentKind,
    releaseChannel,
    profileDir: profileDirInput,
    subprocess: () => overrides.subprocess ?? ctxService(overrides.ctx, 'subprocess'),
    desktopPnpm: () => overrides.desktopPnpm ?? sharedDesktopService(),
    desktopProfiles: () => overrides.desktopProfiles ?? ctxService(overrides.ctx, 'desktopProfiles'),
    pluginManager: () => overrides.pluginManager ?? ctxService(overrides.ctx, 'pluginManager'),
    runtimeExecutable: () => overrides.runtimeExecutable,
    runtimeExecArgs: () => overrides.runtimeExecArgs,
    cliEntry: () => overrides.cliEntry,
    targetPackageName,
    registryUrl,
    installTimeoutMs,
    pluginId,
    log: emitInstallLog,
  })
  // 中立核心不 import node，也不认识插件标识：这里把**绑好插件标识**的发射口递进去（#124）。
  // 不递也能跑，只是没有 update.* 的常驻/按需行；递进去的每一行都走唯一发射口（脱敏/白名单/预算都在里面）。
  const coreLog: UpdateLogPort = logPortFor(pluginId)
  // 源主机名只在宿主侧解析一次（白名单口径在 redaction）：核心只把它填进两格，不自己解析 URL。
  const coreRegistryHost = resolveRegistryHost(registryUrl)
  sharedReader = Object.assign(
    createUpdateReader({
      runningVersion,
      dshVersion,
      profileDir: profileDirInput,
      pluginId,
      profileName: profileNameInput,
      homeDir: overrides.homeDir,
      targetPackageDir: explicitTargetDir || undefined,
      env,
      osHome,
      fetchImpl: overrides.fetchImpl as never,
      now: overrides.now,
      randomId: overrides.randomId,
      nodeVersion: overrides.nodeVersion,
      environmentKind,
      targetPackageName,
      registryUrl,
      checkTimeoutMs,
      confirmationTtlMs,
      releaseChannel,
      readInstalled: overrides.readInstalled,
      readJob: mirroredReadJob,
      writeJob: mirroredWriteJob,
      tryAcquireLock: combinedTryAcquire,
      releaseLock: combinedRelease,
      backupJob: overrides.backupJob ?? disk?.backupJob,
      runInstall: overrides.runInstall ?? defaultRun,
      emitLog: coreLog,
      registryHost: coreRegistryHost,
    }),
    // 跨插件队列的面板侧读写口（#15）：与本次解析出的使用范围绑定，面板经电话可选参数消费。
    { readQueuePruned: loadQueuePruned, writeQueueState: writeQueueBestEffort, queueTtlMs, queueNow },
  )
  sharedReaderKey = key
  return sharedReader
}
/** 安装执行结果进日志（常驻事件 update.install.exec，由执行器在跨边界调用后发）。 */
function emitInstallLog(level: string, event: string, fields: Record<string, unknown>): void {
  emitUpdateLog(level, event, fields)
}

/** 单例复位（测试与门禁口，规格 #591 第 6 条保留）：只清本模块的单例缓存。 */
export function resetSharedUpdateReaderState(): void {
  sharedReader = null
  sharedReaderKey = ''
}
