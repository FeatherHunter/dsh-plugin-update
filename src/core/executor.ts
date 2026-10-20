/**
 * src/core/executor.ts —— 安装执行器（自旧 src/store.ts 执行器段拆出，公共底座在 store-base.ts）。
 *
 * 安装执行按核心给的配方跑三条路由之一（第三方 Desktop 走桌面服务、官方桌面版交给宿主
 * 进程内的插件管理器、普通 DSH 自己起进程），本文件不按操作系统分支，也不拼 shell。
 * 决策顺序全在更新核心。测试一律用假零件，不真写盘真跑命令（经可选的文件读写函数注入，
 * 默认走真文件系统）。
 */

import { randomUUID } from 'node:crypto'
import { link, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { installRecipe, normalizeApprovedBuilds, shellSafeArg } from '../shared/commands.js'
import { DETAIL_MAX_CHARS, MASKED_CREDENTIAL_NOTE, sanitizeDetail } from '../shared/redaction.js'
import { LOG_EVENT_INSTALL_EXEC } from '../shared/log-events.js'
import { attachInstallFail, normalizeCode, normalizeHostCode, readInstallFail } from './failure.js'
import type { InstallFailFacts } from './failure.js'
import type { EnvironmentKind, InstallRecipe, ReleaseChannel } from '../shared/ports.js'
import { fail } from './store-base.js'

/** 运行入口要反查的 CLI 包名（入口必须来自正在运行的这份 CLI）。 */
const CLI_PACKAGE_NAME = '@deepseek-ai/dsh'
/**
 * 官方桌面运行时自带的 CLI 宿主包名（#237）：`dsh web` 的入口是
 * `<包目录>/lib/cli.js`。这个包没有 `bin` 字段、包名也不是 @deepseek-ai/dsh，
 * 只认 npm 布局会把 web/CLI 模式 profile 的一键安装直接打成 spawn-failed。
 */
const DESKTOP_HOST_PACKAGE_NAME = '@deepseek-ai/dsh-desktop-host'
/** 桌面运行时 CLI 宿主包里的入口相对路径（与 npm 布局的 bin 声明等价）。 */
const DESKTOP_HOST_CLI_ENTRY = ['lib', 'cli.js'] as const
/**
 * 安装子进程的流出置：输出只留一段有界缓冲（不读、不落盘），只看退出事实。
 * 必须是「有界收集」形状——子进程能力的 'pipe' 会没人读、'ignore' 不是它的合法取值。
 */
const INSTALL_STDIO = { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } }
/** 终止宽限期：先请进程树自己退，宽限到了再强杀（由子进程能力执行）。 */
const TERMINATION_GRACE_MS = 3000
/**
 * 失败补偿里复探宿主的时限上限（#236）：正常 `listBundles` 是毫秒级；宿主被拖住时也不能让
 * 失败详情永远上不了报——到点按「探测失效」处理，绝不拿缺省猜拓扑。
 */
const PROBE_TIMEOUT_MS = 5000
/**
 * 桌面管理器的三条超时人话格（#184）：按「宿主有没有取消能力」与「卡在哪一步」分支，不许笼统。
 * 没取消能力就一次取消都没发过，不能说「已请求宿主取消」；移除步超时则要先说清包可能已被摘掉。
 */
const INSTALL_TIMEOUT_DETAIL = '安装超时，已请求宿主取消'
const INSTALL_TIMEOUT_NO_CANCEL_DETAIL = '安装超时；宿主未提供取消能力，这次安装可能仍在后台继续'
const REMOVE_TIMEOUT_DETAIL = '移除已装包超时，未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装'
/**
 * 两步配方的第二次没成时要补的事实（#168）：移除已经成功，用户面对的不再是「装着旧版、可重试」，
 * 而是「什么都没装」——必须点明并给一条一定能用的重装命令，否则会把「摘掉了」当成「升级没成功」。
 */
const REINSTALL_AFTER_REMOVAL_DETAIL = '目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装'
/**
 * 未选中的已装包要先恢复选中才能走宿主的两步配方（#201）：真机六个第三方插件都在
 * `dependencies` 里、却不在 `dsh.profile.bundles` 选中名单里，且仍在运行——宿主
 * `removeBundle` 只对选中的 bundle 先取消选中再重载卸载，未选中的包直接判 `bundle-in-use`。
 * 恢复选中本身也可能被宿主拖住，所以同样有额度与诚实超时口径。
 */
const ENABLE_TIMEOUT_DETAIL = '启用已装包超时，未继续安装；请在宿主插件页确认该插件已启用后重试'
/**
 * 宿主没有 `setBundleEnabled` 时的诚实原因（Spec 审查：不能再合成 `bundle-in-use` 冒充
 * 「还有别的层在用」——真实原因是宿主缺恢复选中的能力，和活 fiber 无关）。
 */
const ENABLE_UNSUPPORTED_DETAIL = '宿主不支持恢复选中，无法安全更新已装包，请用载体 CLI 原地更新'
/**
 * 移除失败/超时后的补偿事实（#236）：宿主 `removeBundle` 对**在册**的 bundle 先取消选中
 * （立即写盘，词义见 `CONTEXT.md` 的「在册」）再校验活 fiber，失败时那次取消选中没有回滚。
 * 于是本包拿到「移除失败」时，插件可能已经装着、却不在在册名单（`dsh.profile.bundles`）里——
 * 插件页显示关闭、重启也不加载。本包会把在册状态放回去，并把结果如实说出来：更新失败归更新
 * 失败，插件状态归插件状态，不许含混，也不许谎报已恢复。
 */
const REMOVE_FAILED_RESTORED_DETAIL = '宿主在移除步骤里已把这个插件移出在册名单，本次已恢复在册；更新未完成，重启 DSH 后可重试'
const REMOVE_FAILED_RESTORE_FAILED_DETAIL = '宿主在移除步骤里已把这个插件移出在册名单，恢复在册未成功；请在插件页重新启用'
/**
 * 前置/结果两步里任何一步拿不到明确结论（复探失效、宿主没有恢复能力、恢复调用超时）的档：
 * 只说「无法确认」，既不许谎报已恢复，也不许把「可能」写成「已经」——尤其不能宣称一次没发起的尝试。
 */
const REMOVE_FAILED_RESTORE_UNVERIFIED_DETAIL = '无法确认宿主是否把该插件移出了在册名单，也未能恢复在册；若插件页显示关闭，请重新启用'
/**
 * 这几种拒绝码说明「管理器通道对这个包走不通」：把一定能用的载体 CLI 命令补进人话格，
 * 用户不必再回面板翻手工命令（有些半装态下面板已经不给命令了，见 #168 同类处置）。
 */
const MANAGER_ROUTE_BLOCKED_CODES = new Set(['already-installed', 'bundle-in-use', 'not-removable'])
/**
 * 出口一（第三方 Desktop 的 desktopPnpm 服务）的三格（#193，审查 A 线 R3）：
 * 与出口二 #184 同一套纪律——宿主给了 terminate 才说「已请求终止」，没给就一次终止都没发过、
 * 安装可能还在后台跑；服务直接崩了也要如实说，不许伪装成超时。
 */
const SERVICE_TIMEOUT_DETAIL = '安装超时，已请求宿主终止'
const SERVICE_TIMEOUT_NO_TERMINATE_DETAIL = '安装超时；宿主未提供终止能力，这次安装可能仍在后台继续'
const SERVICE_CRASHED_DETAIL = '宿主安装服务异常退出'
/**
 * 出口三（cli-process）的三格（#185，审查 A 线 R4）：同一套纪律——到点先终止（`handle` 有
 * `terminate` 才真调）、再给终止宽限；没终止能力就如实说安装可能仍在后台；`done` reject 是崩溃
 * 不是超时，三者详情各说各的，不许再笼统成「装失败」。终止由本包直接对子进程调用，所以这里说
 * 「已终止子进程」而不是「已请求宿主终止」。
 */
const CLI_TIMEOUT_DETAIL = '安装超时，已终止子进程'
/** 没终止能力的说法与出口一（桌面服务）共用一条（字面一致，不复制第三份）。 */
const CLI_CRASHED_DETAIL = '宿主子进程能力异常，安装未完成'
/**
 * 到点后宽限内它自己收尾了（非零退出 / 崩溃）：超时仍是超时，但「可能仍在后台继续」已经不成立
 * （#185 Spec 审查：不许拿没发生的事实凑口径）。两个出口共用这句。
 */
const TIMEOUT_SETTLED_DETAIL = '安装超时；任务随后退出，安装未完成'
/**
 * 终止能力在、调用却抛错：不许说「已终止」，也不许甩锅「宿主未提供终止能力」（#185 Spec 审查）。
 */
const TERMINATE_FAILED_DETAIL = '安装超时；终止进程失败，这次安装可能仍在后台继续'

/** 执行零件可以是值，也可以是取值函数（桌面服务要等注入到位才能取）。 */
function part<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

function withExit(error: Error & { exitCode?: number }, exitCode: number | null): Error & { exitCode?: number } {
  if (typeof exitCode === 'number') error.exitCode = exitCode
  return error
}

/** 同一份目录：先按解析后的写法比，再问一次文件系统（能容下大小写与符号链接差异）。 */
async function sameDir(a: string, b: string): Promise<boolean> {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  try {
    if (resolve(a) === resolve(b)) return true
  } catch {
    return false
  }
  try {
    const pair = await Promise.all([realpath(a), realpath(b)])
    return pair[0] === pair[1]
  } catch {
    return false
  }
}

async function readManifestAt(directory: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 从正在运行的入口反查 CLI 的 JS 入口：逐级向上找 CLI 包，且该文件必须正好是包里
 * 声明的入口——npm 布局认名字为 @deepseek-ai/dsh 的包声明的 bin.dsh 或 bin 字符串；
 * 官方桌面运行时认 @deepseek-ai/dsh-desktop-host 包里固定在 lib/cli.js 的入口（#237）。
 * 对不上就返回 null，绝不用 PATH 上的 `dsh` 命令名——否则可能装到别的使用范围或用错版本。
 * 第二参只给测试注入假清单读取器与假路径解析用（默认都走真文件系统）。
 */
export async function resolveCliEntry(
  argv1: string,
  deps: {
    readManifest?: (directory: string) => Promise<Record<string, unknown> | null>
    realpath?: (path: string) => Promise<string>
  } = {}
): Promise<string | null> {
  const readAt = typeof deps.readManifest === 'function' ? deps.readManifest : readManifestAt
  const realpathImpl = typeof deps.realpath === 'function' ? deps.realpath : realpath
  if (typeof argv1 !== 'string' || !argv1 || argv1.includes('\0')) return null
  let entry = ''
  try {
    entry = await realpathImpl(argv1)
  } catch {
    return null
  }
  if (typeof entry !== 'string' || !entry) return null
  let directory = dirname(entry)
  while (true) {
    let manifest: Record<string, unknown> | null = null
    try {
      manifest = await Promise.resolve()
        .then(() => readAt(directory))
        .catch(() => null)
    } catch {
      manifest = null
    }
    if (manifest && manifest.name === CLI_PACKAGE_NAME) {
      const bin = manifest.bin as unknown
      const declared = typeof bin === 'string' ? bin : bin && (bin as Record<string, unknown>).dsh
      if (typeof declared !== 'string' || !declared || isAbsolute(declared) || declared.includes('\0')) return null
      try {
        return (await realpathImpl(resolve(directory, declared))) === entry ? entry : null
      } catch {
        return null
      }
    }
    // #237：官方桌面运行时的 CLI 宿主包没有 bin 声明，入口固定是 <包目录>/lib/cli.js。
    if (manifest && manifest.name === DESKTOP_HOST_PACKAGE_NAME) {
      try {
        return (await realpathImpl(join(directory, ...DESKTOP_HOST_CLI_ENTRY))) === entry ? entry : null
      } catch {
        return null
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export interface ExecutorParts {
  profileName?: string | null | (() => string | null)
  environmentKind?: EnvironmentKind | (() => EnvironmentKind)
  /** 版本通道：查用哪条，装就用哪条（#100：丢了它，预发布精确版在执行器回落 stable，白白 install-failed）。 */
  releaseChannel?: ReleaseChannel | (() => ReleaseChannel)
  profileDir?: string | (() => string)
  subprocess?: unknown | (() => unknown)
  desktopPnpm?: unknown | (() => unknown)
  desktopProfiles?: unknown | (() => unknown)
  /** 官方桌面版进程内的插件管理器（现取，不缓存跨代服务）。 */
  pluginManager?: unknown | (() => unknown)
  runtimeExecutable?: string | (() => string | undefined)
  runtimeExecArgs?: string[] | (() => string[] | undefined)
  cliEntry?: string | (() => string | undefined)
  targetPackageName?: string | (() => string)
  registryUrl?: string | (() => string)
  installTimeoutMs?: number | (() => number)
  pluginId?: string | (() => string)
  /**
   * 一次安装调用携带的「已批准构建脚本」名单（#194）：由执行器从 runInstall 入参归一带入，
   * 管理器路把它作为 `installBundle` 的 `approvedBuilds` 选项交回宿主（先批准再跑 pnpm）。
   * 只在本次调用内有效，不进任务、不落盘、不跨请求复用。
   */
  approvedBuilds?: string[]
  log?: (level: string, event: string, fields: Record<string, unknown>) => void
}

/**
 * 记一行安装执行的跨边界调用与结果（常驻事件，低频，只记路由与退出事实加插件标识）。
 * 日志里只记枚举与数字，不记命令、路径、使用范围名原文。
 */
function emitInstall(
  parts: ExecutorParts,
  recipe: { route: string } | null,
  ok: boolean,
  exitCode: number | null,
  durationMs: number
): void {
  const log = parts.log
  if (typeof log !== 'function') return
  try {
    const pluginId = part(parts.pluginId ?? null) as unknown
    log('info', LOG_EVENT_INSTALL_EXEC, {
      route: recipe ? recipe.route : 'none',
      ok: ok === true,
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      durationMs,
      pluginId: typeof pluginId === 'string' ? pluginId : null,
    })
  } catch {}
}

/**
 * 执行现场的失败分类（#207 / 审查 S1-2）：路由分支早就知道「超时/崩溃/非零退出/起进程失败/
 * 终止失败/宿主拒绝」，以前只变成一句人话详情；现在把事实挂到抛错上，服务侧一条原因行即可落盘。
 * 只挂稳定枚举与数字，不碰错误码、消息与既有 detail 形状。
 */
function failExec(
  error: Error,
  facts: { reason: InstallFailFacts['reason']; code?: string; hostCode?: string; exitCode?: number | null }
): Error {
  return attachInstallFail(error, {
    stage: 'exec',
    reason: facts.reason,
    // 码格只收本包码面：执行器抛出的码是 install-failed；宿主自由标识走 hostCodeHash，不进这格。
    code: normalizeCode(facts.code ?? (error as { code?: unknown })?.code),
    hostCode: facts.hostCode ?? 'none',
    check: 'none',
    exitCode: typeof facts.exitCode === 'number' && Number.isInteger(facts.exitCode) ? facts.exitCode : null,
  })
}

/**
 * 桌面宿主：交给桌面端公开的 desktopPnpm 服务，由它用参数数组拉起打包好的 CLI。
 *
 * 出口一原来只 `await handle.done`、根本不执行安装时限（#193 / 审查 A 线 R3）：宿主服务不收尾，
 * 作业就永久停在 `installing`，之后所有动作 `update-busy`，用户只能在宿主重启前干等。
 * 这里照出口二（#184）的纪律：deadline + 终止（`handle` 有 `terminate` 才真调）+ 终止宽限 +
 * 诚实超时口径——没终止能力就如实说「这次安装可能仍在后台继续」，绝不谎称已请求终止。
 */
async function runDesktopService(
  recipe: { pluginArgs: string[]; profileName: string; timeoutMs: number },
  parts: ExecutorParts
): Promise<number | null> {
  const service = part(parts.desktopPnpm) as { runPlugin?: (args: string[], dir: string, extra: undefined) => { done: Promise<{ exitCode?: number }> } } | null
  if (!service || typeof service.runPlugin !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const profiles = part(parts.desktopProfiles) as { current?: { dir?: string } } | null
  const active = profiles && profiles.current ? profiles.current : null
  const profileDir = part(parts.profileDir) as string
  // 桌面服务固定装进「当前激活的使用范围」，所以激活范围必须就是本插件所在的那个；
  // 对不上宁可不装（装错范围比装不上更糟），交回核心按诚实失败转手工命令。
  if (!active || !active.dir || !profileDir || !(await sameDir(active.dir, profileDir)))
    throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const handle = service.runPlugin(recipe.pluginArgs, profileDir, undefined)
  if (!handle || !handle.done || typeof handle.done.then !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  // 双流由调用方负责读（契约）：先挂监听再等退出，失败原文才拿得到。
  const readOutput = streamCollectorOf(handle)
  const canTerminate = typeof (handle as { terminate?: unknown }).terminate === 'function'
  const terminate = canTerminate ? (handle as unknown as { terminate: () => void }).terminate : null
  let terminated = false
  let terminateFailed = false
  // 结局只分三种：自己收尾 / 崩了（done reject） / 到点；先把 reject 折成事实，不要让它冒充超时。
  const settled = Promise.resolve(handle.done).then(
    (value) => ({ kind: 'settled' as const, value }),
    () => ({ kind: 'crashed' as const, value: null })
  )
  const timeoutMs = typeof recipe.timeoutMs === 'number' && recipe.timeoutMs > 0 ? recipe.timeoutMs : 0
  const TIMEOUT = Symbol('install-timeout')
  let timer: ReturnType<typeof setTimeout> | null = null
  const outcome = await (async () => {
    if (timeoutMs === 0) return await settled
    const deadline = new Promise<typeof TIMEOUT>((settle) => {
      timer = setTimeout(() => {
        try {
          if (terminate !== null) {
            terminate.call(handle)
            terminated = true
          }
        } catch {
          terminateFailed = true
        }
        settle(TIMEOUT)
      }, timeoutMs)
    })
    try {
      return await Promise.race([settled, deadline])
    } finally {
      if (timer !== null) {
        try {
          clearTimeout(timer)
        } catch {}
      }
    }
  })()
  if (outcome === TIMEOUT) {
    // 到点时已经点过 terminate（有终止能力才会真调）；再给一段收尾宽限，拿到真实结局就按它自己的
    // 结局判——不把已经落地的改动记成失败（同出口二 finishCall 的宽限纪律）；口径仍点名超时，
    // 但按「终止是否真发出 / 任务是否已收尾」选词，不许拿没发生的事实凑（#185 Spec 审查）。
    const late = await settleWithin(settled, TERMINATION_GRACE_MS)
    const lateCode = late && late.kind === 'settled' ? (late.value && typeof late.value.exitCode === 'number' ? late.value.exitCode : null) : null
    if (late && late.kind === 'settled' && lateCode === 0) return 0
    const hint = timeoutHintOf(
      { terminated, ended: late !== null, terminateFailed },
      { terminated: SERVICE_TIMEOUT_DETAIL, noTerminate: SERVICE_TIMEOUT_NO_TERMINATE_DETAIL }
    )
    const excerpt = causeExcerptOf(readOutput())
    throw failExec(withDetail(withExit(fail('install-failed'), lateCode), excerpt ? withTimeoutHint(excerpt, hint) : hint), {
      reason: terminateFailed ? 'terminate-failed' : 'timeout',
      exitCode: lateCode,
    })
  }
  if (outcome.kind === 'crashed') {
    throw failExec(withDetail(fail('install-failed'), causeExcerptOf(readOutput()) || SERVICE_CRASHED_DETAIL), { reason: 'crashed' })
  }
  const code = outcome.value && typeof outcome.value.exitCode === 'number' ? outcome.value.exitCode : null
  if (code !== 0) throw failExec(withDetail(withExit(fail('install-failed'), code), causeExcerptOf(readOutput())), { reason: 'nonzero-exit', exitCode: code })
  return code
}

/**
 * 宿主管理器的回包（只声明本包用到的那几格）。
 * 出处：官方桌面版 `@deepseek-ai/dsh-plugin-manager` 的 ChangeResult；契约抄件见 docs/host-install-exits.md。
 */
interface ManagerChangeResult {
  application?: unknown
  error?: unknown
  /**
   * pnpm 的退出事实与原文就在这格（只抄本包用到的两格）：失败原文的唯一来源。
   * `exitCode` 是真跑过 pnpm 时的退出码（#R8 对抗审查：以前只抄 output，失败日志里
   * 真实退码被丢掉，一律记成 null——探针给 137 也一样）。
   */
  packageResult?: {
    output?: unknown
    exitCode?: unknown
    /**
     * 兼容性预检拒绝的明细（#195）：host 契约里与 `error.incompatible` 同形状，
     * `requirements` 的键是 `engines.dsh` 或 DSH peer 包名，值是不满足的范围；
     * `runtimeVersion` 是当前 DSH 版本。用来把「裸码」翻成「要求 ≥X（当前 Y）」。
     */
    incompatible?: unknown
  }
  /**
   * 待批准的构建脚本（#194）：宿主的 pnpm 失败且报告了「被忽略的构建脚本」时，会先把
   * `recordPendingBuilds()` 的结果（等待构建决策的精确包名）写进这一格再 throw；
   * 宿主的 `change()` 把部分结果折进 resolve 出来的失败回包，所以这格能到本包手里。
   * 重试时以 `approvedBuilds` 选项交回宿主（宿主先 approveBuilds 再跑 pnpm）。
   */
  pendingBuilds?: unknown
}

/** 成功三态：overridden 是「改动已被保留、只是被别的层盖住」，不是失败。 */
const MANAGER_OK = ['applied', 'restart-required', 'overridden']

function withDetail(error: Error & { detail?: string }, detail: string): Error & { detail?: string } {
  if (detail) error.detail = detail
  return error
}

/**
 * 脱敏规则表见 src/shared/redaction.ts（#19）：五条具名规则 + 固定顺序 + 两占位符 + 空白边界封顶。
 * 本文件只经 `sanitizeDetail` 消费它（唯一自由文本出口），不自建规则、不做运行时事后扫描。
 */

/** 管理器失败时的 error 是普通对象（code／diagnostic），不是 Error；两种都要能读。 */
function detailText(error: unknown): string {
  if (typeof error === 'string') return sanitizeDetail(error)
  if (error instanceof Error) return sanitizeDetail(error.message)
  if (error && typeof error === 'object') {
    const shape = error as { code?: unknown; diagnostic?: unknown; message?: unknown }
    const code = typeof shape.code === 'string' ? shape.code : ''
    const said = typeof shape.diagnostic === 'string' ? shape.diagnostic : typeof shape.message === 'string' ? shape.message : ''
    const line = [code, said].filter(Boolean).join(': ')
    if (line) {
      const clean = sanitizeDetail(line)
      // 脱敏已改成「只遮盖 userinfo、保留其余原文 + 末尾声明」（#198），正常不会回空串。
      // 仍留一道兜底：万一 line 被收成空，退到 code 本身，绝不把空详情当成功。
      if (clean) return clean
      if (code) return sanitizeDetail(code)
      return ''
    }
    try {
      return sanitizeDetail(JSON.stringify(error))
    } catch {
      return sanitizeDetail(String(error))
    }
  }
  return error === undefined || error === null ? '' : sanitizeDetail(String(error))
}

/** 抓取读数上限（与 INSTALL_STDIO 同一 64 KiB 口径）：够挑出错误码行即可，不留整段日志。 */
const COLLECT_MAX_BYTES = 64 * 1024

/**
 * 安装原文里「签名行」的样子：装的是谁、何时发布、门限几时到、以及 pnpm 的错误码。
 * 认因（src/core/cause.ts）要的是整条签名，不是单独一个错误码。
 */
const CAUSE_SIGNATURE_LINE = /ERR_PNPM_[A-Z0-9_]+|(^|\s)ERR!|published|cutoff|minimumReleaseAge|Cannot install/i

/**
 * 从安装输出里挑出「因」：三条宿主路其实都把 pnpm 原文交给我们（cli 路的抓取读数、
 * 桌面服务路的双流、管理器路的 packageResult.output），但 detail 封顶只有 300 字，
 * 而 pnpm 把错误码打在日志尾巴上——先挑错误码行（连带紧邻上面的签名行），
 * 挑不到退最后一段，原文才活得到面板。
 * 脱敏仍只经唯一出口 sanitizeDetail。
 * 2026-10-17 对抗审查（#156）：这格此前无人生产，24h 年龄门的原文到不了面板，
 * 「装合规版」四个入口在生产形状下全都认不出因；第四轮又发现真报文是分行的
 * （签名在上、错误码单独在最后一行），只取错误码行等于把签名丢掉，故一并收签名行。
 */
function causeExcerptOf(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : ''
  if (!text) return ''
  const lines = text.split('\n')
  const at = lines.findIndex((line) => /ERR_PNPM_[A-Z0-9_]+|(^|\s)ERR!/.test(line))
  if (at >= 0) {
    // 错误码行未必自带因：pnpm 也把「装的是谁、何时发布、门限几时到」留在上面几行，
    // 错误码单独打在最后一行。认因要的是整条签名，光揣一个错误码等于没认出因——
    // 所以把紧邻上面的签名行一并收进来（2026-10-17 #156 第四轮：真机形状就是这种分行的）。
    const above: string[] = []
    for (let i = at - 1; i >= 0 && above.length < 2; i--) {
      const line = lines[i].trim()
      if (line && CAUSE_SIGNATURE_LINE.test(line)) above.unshift(line)
    }
    const picked = [...above, ...lines.slice(at, at + 3).map((line) => line.trim()).filter(Boolean)].join(' ')
    return sanitizeDetail(picked)
  }
  // 挑不到错误码行：从最后一行往前收（pnpm 把结论打在最后），最近的一行放最前，
  // 重复的进度行只留一次——既不丢结论，也不把开头那句进度日志当因。
  const picked: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0 && size < DETAIL_MAX_CHARS; i--) {
    const line = lines[i].trim()
    if (!line || picked.includes(line)) continue
    picked.push(line)
    size += line.length + 1
  }
  return picked.length === 0 ? '' : sanitizeDetail(picked.join(' '))
}

/**
 * cli 路：宿主 subprocess 的抓取读数。契约（@deepseek-ai/dsh-subprocess README）：
 * `spawn({ …, stdio: { stdin:'ignore', stdout:{ maxBytes }, … } })` 后
 * `handle.collected.stdout?.readFrom(0)` → `{ text, lossy, spillPath? }`，**退出后仍可读**；
 * `done` 只报退出事实。老宿主/假件没有这格 → 空串，不炸、不猜。
 */
function collectedOutputOf(handle: unknown): string {
  const collected = (handle as { collected?: { stdout?: unknown; stderr?: unknown } } | null)?.collected
  const parts: string[] = []
  for (const stream of [collected?.stderr, collected?.stdout]) {
    try {
      const read = (stream as { readFrom?: (offset: number) => { text?: unknown } } | null)?.readFrom?.(0)
      if (read && typeof read.text === 'string' && read.text) parts.push(read.text)
    } catch {}
  }
  return parts.join('\n')
}

/**
 * 桌面服务路：契约给的 `handle.stdout/stderr` 双流由**调用方自己读**（不读就永远没有原文）。
 * 先要 utf8 文本（流是宿主的，能要就要），再挂 data 监听、只留前 64 KiB；
 * 读失败一律吞掉，不影响成败判定。
 */
function streamCollectorOf(handle: unknown): () => string {
  const chunks: string[] = []
  let kept = 0
  const shape = handle as { stdout?: unknown; stderr?: unknown } | null
  const attach = (stream: unknown): void => {
    const on = (stream as { on?: (event: string, cb: (chunk: unknown) => void) => unknown } | null)?.on
    if (typeof on !== 'function') return
    const setEncoding = (stream as { setEncoding?: (encoding: string) => unknown } | null)?.setEncoding
    try {
      if (typeof setEncoding === 'function') setEncoding.call(stream, 'utf8')
    } catch {}
    try {
      on.call(stream, 'data', (chunk: unknown) => {
        if (kept >= COLLECT_MAX_BYTES) return
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
        if (!text) return
        kept += text.length
        chunks.push(text)
      })
    } catch {}
  }
  attach(shape?.stderr)
  attach(shape?.stdout)
  return () => chunks.join('')
}

/**
 * 管理器只吃一个 spec 字符串；配方给的就是 ['add', spec]，别的形状一律不试也不猜。
 * 编码处见 src/shared/commands.ts 的 installRecipe——改这条形状要同时改两处（五键冻结，只能这样传）。
 */
function managerSpecOf(pluginArgs: string[]): string | null {
  if (!Array.isArray(pluginArgs) || pluginArgs.length !== 2) return null
  const [verb, spec] = pluginArgs
  if (verb !== 'add' || typeof spec !== 'string' || !spec || spec.startsWith('-')) return null
  return spec
}

/**
 * 拼「宿主原文；下一步」并守住 detail 的 300 字：原文在前、建议在后。
 * 超长时剪原文的尾巴，但不把脱敏核追加在末尾的「（原话里的账号密码已隐去…）」说明剪半
 * （ADR-0001 决策 2：被替换过的文本必须仍能与原样文本区分）。
 */
function withTrailingHint(said: string, hint: string): string {
  if (!hint) return said
  const room = DETAIL_MAX_CHARS - hint.length - 1
  if (room <= 0) return hint
  const head = said.length > room ? clipDetailForHint(said, room) : said
  return head ? `${head}；${hint}` : hint
}
function clipDetailForHint(said: string, room: number): string {
  const noteSuffix = `；${MASKED_CREDENTIAL_NOTE}`
  if (said.endsWith(noteSuffix) && room > noteSuffix.length + 1) {
    const cut = room - noteSuffix.length - 1
    return `${said.slice(0, cut)}…${noteSuffix}`
  }
  return said.slice(0, room)
}
/** 拼「宿主原文；超时/崩溃口径」：原文在前、下一步在后，总长仍守 detail 的 300 字（#193）。 */
function withTimeoutHint(said: string, hint: string): string {
  return withTrailingHint(said, hint)
}
/**
 * 到点后按「终止是否真发出 / 任务是否已收尾」挑人话格：三者互斥，不许拿没发生的事实凑口径。
 * `terminated` = terminate 真的调成功；`ended` = 宽限内自己收尾（含崩溃）；
 * `terminateFailed` = 有终止能力但调用抛错。
 */
function timeoutHintOf(
  facts: { terminated: boolean; ended: boolean; terminateFailed: boolean },
  wording: { terminated: string; noTerminate: string }
): string {
  if (facts.terminated) return wording.terminated
  if (facts.ended) return TIMEOUT_SETTLED_DETAIL
  if (facts.terminateFailed) return TERMINATE_FAILED_DETAIL
  return wording.noTerminate
}
/** 等管理器回话：带时限；到点先请它取消（能不能取消由它答），再由调用方决定怎么收场。 */
async function raceManager(
  running: Promise<ManagerChangeResult>,
  timeoutMs: number,
  requestCancel: () => Promise<unknown>
): Promise<{ timedOut: false; value: ManagerChangeResult } | { timedOut: true }> {
  const settled = Promise.resolve(running).then((value) => ({ timedOut: false as const, value }))
  if (!(typeof timeoutMs === 'number' && timeoutMs > 0)) return await settled
  const TIMEOUT = Symbol('install-timeout')
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<typeof TIMEOUT>((settle) => {
    timer = setTimeout(() => settle(TIMEOUT), timeoutMs)
  })
  let winner: { timedOut: false; value: ManagerChangeResult } | typeof TIMEOUT
  try {
    winner = await Promise.race([settled, deadline])
  } finally {
    if (timer !== null) {
      try {
        clearTimeout(timer)
      } catch {}
    }
  }
  if (winner !== TIMEOUT) return winner
  await requestCancel()
  return { timedOut: true }
}

/** 宽限期内等它自己收尾：到点还没落定就回 null（调用方自己做诚实失败）。中途抛错照样往外抛。 */
async function settleWithin<T>(promise: Promise<T>, graceMs: number): Promise<T | null> {
  if (!(typeof graceMs === 'number' && graceMs > 0)) return null
  const EXPIRED = Symbol('grace-expired')
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<typeof EXPIRED>((settle) => {
    timer = setTimeout(() => settle(EXPIRED), graceMs)
  })
  try {
    const winner = await Promise.race([promise, deadline])
    return winner === EXPIRED ? null : (winner as T)
  } finally {
    if (timer !== null) {
      try {
        clearTimeout(timer)
      } catch {}
    }
  }
}

/** 管理器只吃一个 spec 字符串；包名就是最后一个 '@' 之前那段（`@scope/name@1.2.3` → `@scope/name`）。 */
function managerPackageNameOf(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : ''
}

/**
 * 宿主在 HMR 宿主上对「已经装着的包」的同步拒绝：`application:'failed'` + `error.code === 'already-installed'`。
 * 它在 pnpm 之前就回，所以没有子进程、也没有操作日志——只有回包能认出来。
 */
function managerSaidAlreadyInstalled(result: ManagerChangeResult): boolean {
  if (!result || typeof result.application !== 'string' || result.application !== 'failed') return false
  const error = result.error
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code === 'already-installed'
}

/**
 * 管理器 `listBundles()` 的包拓扑（本包只需两格，其余一律不看）：
 * - `enabled`：是否在 `dsh.profile.bundles` 选中名单里——宿主只对选中的 bundle 做卸载重载；
 * - `removable`：宿主是否允许移除。官方桌面版里第三方包的 `removable = installed && !shipped`。
 */
interface ManagerBundleTopology {
  /** 选中名单成员；`null` 表示宿主这一版没给这格（不拿缺省当否，避免误改用户拓扑）。 */
  enabled: boolean | null
  /** 是否允许移除；`null` 表示宿主没给这格（不拿缺省当拒绝，避免误报 `not-removable`）。 */
  removable: boolean | null
}

/** 宿主证据只见过「直接回数组」一种形状；别的形状当没有（调用方退回旧两步，不猜）。 */
function managerBundleRowsOf(said: unknown): Record<string, unknown>[] {
  if (!Array.isArray(said)) return []
  return said.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
}

/**
 * 为「更新一个已在册的包」探一次宿主拓扑（#201）。管理器没有 `listBundles`、或调用失败、
 * 或清单里找不到这个包，都回 null——调用方退回旧两步配方，不拿猜测代替探测。
 */
async function probeManagerTopology(
  manager: { listBundles?: () => unknown },
  name: string
): Promise<ManagerBundleTopology | null> {
  const listBundles = manager.listBundles
  if (typeof listBundles !== 'function') return null
  let said: unknown
  try {
    said = await listBundles.call(manager)
  } catch {
    return null
  }
  const row = managerBundleRowsOf(said).find((item) => item.name === name)
  if (!row) return null
  // 三态归一：宿主明确给了布尔值才采信，缺格/异形一律 `null`（调用方只对明确的 false 动作）。
  const tri = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
  return { enabled: tri(row.enabled), removable: tri(row.removable) }
}

/**
 * 带时限的拓扑探测（#236）：失败补偿里的复探不能无限等宿主——`listBundles` 若被拖住，
 * 失败详情就永远上不了报。到点按「探测失效」（null）处理，调用方绝不拿缺省猜拓扑。
 * 时限只用于补偿路径；装前的探测保持旧行为（宿主自己会把 `change()` 排队，不在这里另加钟）。
 */
async function probeManagerTopologyWithin(
  manager: { listBundles?: () => unknown },
  name: string,
  timeoutMs: number
): Promise<ManagerBundleTopology | null> {
  if (!(timeoutMs > 0)) return probeManagerTopology(manager, name)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([probeManagerTopology(manager, name), expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 移除失败/超时后的在册补偿（#236）：宿主 `removeBundle` 对在册的 bundle 是「先取消选中
 * （`selectBundle(name,false)`，立即写盘）再重载卸载」，活 fiber 没卸掉就抛 `bundle-in-use`；
 * 外层 `change()` 只把结果标 `failed`，那次取消选中没有回滚——于是本包拿到失败时插件已装着、
 * 却不在 `dsh.profile.bundles` 里（插件页关闭、重启不加载）。
 *
 * 只在「移除前已探到在册（`enabled === true`）」时动手：先复探一次，确认已不在册就
 * best-effort `setBundleEnabled(name, true)`；恢复后再复探一次，只有明确回到在册才敢说「已恢复」。
 * 装前本来未在册的（#201 先启用再移除）不恢复——回到用户原本状态；前置态未知（老宿主没有
 * `listBundles`、或探测抛错）不猜拓扑、不动在册名单。返回值是可追加的如实事实，'' 表示无需补偿。
 *
 * 恢复调用本身也走宿主 `change()`，可能被拖住：额度取「剩余配方额度」与「终止宽限」的较大者，
 * 到点再给一次收尾宽限，仍不落定就报「无法确认」，绝不无限重试。两次复探同样带时限（#236），
 * 探测失效按「无法确认」档处理，绝不把没看到的事写成事实。
 */
async function restoreEnabledAfterRemovalFailure(
  manager: { listBundles?: () => unknown; setBundleEnabled?: (name: string, enabled: boolean) => unknown },
  name: string,
  enabledBeforeRemoval: boolean | null,
  nextStepTimeoutMs: () => number
): Promise<string> {
  if (enabledBeforeRemoval !== true) return ''
  // 失败补偿里的每次复探都带时限：宿主若被拖住，失败详情也要能上报（探测失效按 null 处理，不猜拓扑）。
  const probeMs = Math.min(Math.max(nextStepTimeoutMs(), TERMINATION_GRACE_MS), PROBE_TIMEOUT_MS)
  const probeWithin = (): Promise<ManagerBundleTopology | null> => probeManagerTopologyWithin(manager, name, probeMs)
  // 复探：宿主若在失败前已完成取消选中，这里能看到；仍在册（或宿主没给结论）时再尽力恢复。
  const afterFailure = await probeWithin()
  if (afterFailure !== null && afterFailure.enabled === true) return ''
  // 只有明确看到「已被移出」才算确认；null（探测失效）不许当成事实往下写。
  const removedConfirmed = afterFailure !== null && afterFailure.enabled === false
  const setBundleEnabled = manager.setBundleEnabled
  if (typeof setBundleEnabled !== 'function') return REMOVE_FAILED_RESTORE_UNVERIFIED_DETAIL
  const restoreState = async (): Promise<'enabled' | 'failed' | 'unknown'> => {
    const enabling = Promise.resolve(setBundleEnabled.call(manager, name, true)) as Promise<ManagerChangeResult>
    const recoveryMs = Math.max(nextStepTimeoutMs(), TERMINATION_GRACE_MS)
    const outcome = await raceManager(enabling, recoveryMs, async () => 'not-running')
    const settled = outcome.timedOut ? await settleWithin(enabling, TERMINATION_GRACE_MS) : outcome.value
    if (!settled) {
      void enabling.catch(() => {})
      return 'unknown'
    }
    const application = settled && typeof settled.application === 'string' ? settled.application : ''
    return MANAGER_OK.includes(application) ? 'enabled' : 'failed'
  }
  const restored = await restoreState().catch((): 'unknown' => 'unknown')
  if (restored !== 'enabled') {
    // 只有复探确认「已被移出」且恢复调用明确失败，才把「恢复未成功」说成事实；
    // 前置结论不明（null）或恢复调用超时，一律只说「无法确认」。
    return removedConfirmed && restored === 'failed'
      ? REMOVE_FAILED_RESTORE_FAILED_DETAIL
      : REMOVE_FAILED_RESTORE_UNVERIFIED_DETAIL
  }
  // 宿主回了成功不等于真落盘：再探一次，只有明确回到在册才敢说「已恢复」。
  const afterEnable = await probeWithin()
  if (afterEnable !== null && afterEnable.enabled === true) return REMOVE_FAILED_RESTORED_DETAIL
  if (afterEnable !== null && afterEnable.enabled === false) return REMOVE_FAILED_RESTORE_FAILED_DETAIL
  return REMOVE_FAILED_RESTORE_UNVERIFIED_DETAIL
}

/**
 * 载体 CLI 的原位更新命令（官方桌面版自带 `dsh plugin --profile <名> …` 通道，参数逐字转给 pnpm）。
 *
 * 形状与 `src/shared/commands.ts` 的 `manualCommand` 同源（`add --save-exact <包>@<版本> --registry=<源>`）：
 * 管理器配方自己的 `pluginArgs` 只有「add + spec」两个元素（它不接受开关），所以这里按包名与源
 * 重新拼成命令行能直接执行的形状；源未知时不附 `--registry=`（用户也可自行去掉）。
 * 管理器路的三个位置（启用缺失、移除超时、重装失败）共用这一份实现，避免各行拼出不同命令。
 *
 * 插值只走 `shellSafeArg` 的保守白名单（与 `manualCommand` 同一政策）：使用范围名 / 源 / 规格
 * 含空白、`$`、反引号、引号、`&` 等任意一个就返回 null——**宁可不出命令，也不出会被 shell
 * 展开、截断或悄悄换源的假命令**（对抗审查 HARD：`JSON.stringify` 不是 shell 引号）。
 */
function carrierAddCommand(profileName: string, spec: string, registry: string | null): string | null {
  const arg = shellSafeArg(profileName)
  const named = shellSafeArg(spec)
  if (!arg || !named) return null
  if (registry === null) return `dsh plugin --profile ${arg} add --save-exact ${named}`
  const source = shellSafeArg(registry)
  if (!source) return null
  return `dsh plugin --profile ${arg} add --save-exact ${named} --registry=${source}`
}

/**
 * 载体 CLI 的构建批准命令（#194）：`dsh plugin` 把参数逐字转给 pnpm，所以
 * `approve-builds` 就是宿主自带 CLI 的批准通道（交互式列出现有清单）。插值同
 * {@link carrierAddCommand}：使用范围名不安全就不出命令，绝不拼半句。
 */
function carrierApproveBuildsCommand(profileName: string): string | null {
  const arg = shellSafeArg(profileName)
  if (!arg) return null
  return `dsh plugin --profile ${arg} approve-builds`
}

/**
 * 待批构建名单的建议候选（#194）：名单从「全点名」逐级退让到「首个 等 N 个」，
 * 但**每一条候选都带着能走的批准路径**——长名单也不能只剩一句「去宿主页批准」。
 * 只负责措辞，不做过滤——名单进来前已经过 `normalizeApprovedBuilds`。
 *
 * Spec 审查 HARD：旧实现只在第一条候选里带 CLI 命令，名单一长就落到没有命令的短句，
 * 而宿主页的批准入口只在它自己的安装失败页出现，本包的 `updateInstall` 走不到——
 * 等于告诉用户一个不存在的按钮。现在命令（或没有命令时的宿主页说法）是每条的固定部分，
 * 变的是点名多少个包。
 */
function pendingBuildsAdviceCandidates(names: string[], approveCommand: string | null): string[] {
  if (names.length === 0) return []
  const total = names.length
  const suffix = approveCommand
    ? `；请先批准构建脚本（运行 ${approveCommand}），再重试本次安装`
    : '；请先在宿主的插件管理里批准该包的构建脚本，再重试'
  const candidates: string[] = []
  for (let count = total; count >= 1; count -= 1) {
    const list = count === total ? names.join('、') : `${names.slice(0, count).join('、')} 等 ${total} 个`
    candidates.push(`需要批准构建脚本：${list}${suffix}`)
  }
  candidates.push(`有构建脚本被忽略${suffix}`)
  return candidates
}

/**
 * 摘掉人话格里业已存在的构建批准建议（#194）：两段式路径上 `failureOf` 会在尾部补一次，
 * 而 `withRemovalFact` 要按「原话 → 批准建议 → 移除事实」重新排版，避免重复与位置丢失。
 */
function stripPendingBuildsAdvice(detail: string): string {
  const marker = detail.search(/[；]?(?:需要批准构建脚本：|有构建脚本被忽略|安装脚本需要批准（pendingBuilds）)/u)
  return marker >= 0 ? detail.slice(0, marker) : detail
}

/**
 * 把「需要批准的构建脚本」点名到人话格里（#194）：宿主原话在前、本包建议在后。
 *
 * 名单是宿主 `recordPendingBuilds` 给的精确包名（调用方已归一，这里按同一白名单再兜底一遍），
 * 通配规则与开关样式不进文案。文案按预算退让：全名单 → 少点几个名 → 「首个 等 N 个」→
 * 「有构建脚本被忽略」；**无论退到哪一级，批准路径（CLI 命令，或没有命令时的宿主页说法）
 * 都保留**。宿主码 `build-blocked` 自带的通用建议会被本函数的具体建议取代（同义不重复）。
 */
function withPendingBuildsHint(
  error: Error & { detail?: string },
  names: string[],
  approveCommand: string | null
): Error & { detail?: string } {
  const candidates = pendingBuildsAdviceCandidates(names, approveCommand)
  if (candidates.length === 0) return error
  const said = stripPendingBuildsAdvice(typeof error.detail === 'string' ? error.detail : '')
  for (const hint of candidates) {
    const room = DETAIL_MAX_CHARS - hint.length - 1
    if (room < 0) continue
    const head = said.length > room ? said.slice(0, room) : said
    return withDetail(error, head ? `${head}；${hint}` : hint)
  }
  // 候选里最短的一条仍超预算（理论上不会：最后一条是固定短句）——只留截断原文，绝不越界。
  return withDetail(error, said.slice(0, DETAIL_MAX_CHARS))
}

/**
 * 无条件把载体 CLI 命令补在详情尾部（启用步用：这一步的失败没有宿主拒绝码可判，但用户
 * 同样需要「换通道」的下一步）。原文在前、总长守 DETAIL_MAX_CHARS；命令本身超预算时
 * 宁可只留原文，绝不输出越界详情（Spec 审查：room<=0 曾把全文拼回去）。
 * 命令为 null（插值不安全，见 `carrierAddCommand`）时一字不加；原文里已经带过同一条命令时
 * 也不重复补（重装失败先经 `failureOf`、再经 `withRemovalFact` 的两段式路径）。
 */
function withCarrierHint(error: Error & { detail?: string }, command: string | null): Error & { detail?: string } {
  if (command === null) return error
  const said = typeof error.detail === 'string' ? error.detail : ''
  if (said.includes(command)) return error
  const suffix = ` (${command})`
  const room = DETAIL_MAX_CHARS - suffix.length - 1
  if (room <= 0) return withDetail(error, said.slice(0, DETAIL_MAX_CHARS))
  const head = said.length > room ? said.slice(0, room) : said
  return withDetail(error, head ? `${head}${suffix}` : suffix.trim())
}

/**
 * 管理器通道明确走不通时，把载体 CLI 的原位更新命令补在宿主原话之后（原文在前、建议在后）。
 */
function withManagerRetryHint(
  error: Error & { detail?: string },
  result: ManagerChangeResult,
  command: string | null
): Error & { detail?: string } {
  const code = managerCodeOf(result)
  if (!MANAGER_ROUTE_BLOCKED_CODES.has(code)) return error
  return withCarrierHint(error, command)
}

/**
 * 管理器拒绝码的「下一步」翻译（#R1 对抗审查，S2「报错无下一步」）。
 *
 * 宿主自己有一张 ERROR_STEPS 表（`asar:…/dsh-plugin-manager/lib/types/tools.js:7-21`）给每个拒绝码
 * 写了下一步，但那是写给模型看的英文。本包把用户真会撞上的几码翻成一行中文动作，**拼在宿主原话后面**：
 * 原文永远在前（出事时还能按码搜索/报给宿主），建议永远在后；认不出的码一句不加，绝不替宿主编原因。
 * 只覆盖管理器路会原样透出的那几码（A 线探针逐个撞过）。
 */
const MANAGER_CODE_HINTS: Record<string, string> = {
  'already-installed': '宿主不支持自动移除重装，请复制手工命令在桌面 CLI 里更新',
  'not-removable': '宿主把这个包标为不可移除，请复制手工命令在桌面 CLI 里更新',
  'management-required': '这个条目归宿主插件管理本体所有，不能在这里更新',
  'not-bundle': '这个包没有声明 dsh.bundle，不能当作插件管理',
  'bundle-in-use': '可能已被宿主移出在册名单；请重启 DSH 后重试更新，若插件页显示关闭请重新启用',
  'stop-profile': '这个使用范围没有 HMR，请停掉 DSH 后在命令行更新',
  'stale-approval': '构建批准名单已过期（宿主已重新记录），请重新发起更新，不要沿用上次的批准名单',
  'incompatible-version': '新版本与当前 DSH 不兼容，请先升级 DSH 再更新',
  'build-blocked': '安装脚本需要批准（pendingBuilds），请在宿主插件页批准构建后重试',
  'pnpm-missing': '宿主找不到 pnpm，请先安装 pnpm',
  'disk-full': '磁盘空间不足，腾出空间后重试',
  permission: '宿主写不了使用范围目录，修好权限后重试',
}

/** 从管理器回包的 error 里读本包认识的那一格（只认字符串 code，别的一律当没有）。 */
function managerCodeOf(result: ManagerChangeResult): string {
  const error = result ? result.error : undefined
  if (!error || typeof error !== 'object') return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/** 拼「宿主原话；下一步」，总长仍守 detail 的 300 字：原文优先，建议让位。 */
function withManagerHint(result: ManagerChangeResult, said: string): string {
  const code = managerCodeOf(result)
  const hint = code ? MANAGER_CODE_HINTS[code] ?? '' : ''
  return withTrailingHint(said, hint)
}

/**
 * 宿主拒绝 `incompatible-version` 的明细（#195）：`incompatible[]` 每项带 `requirements`
 * （键是 `engines.dsh` 或 DSH peer 包名，值是不满足的范围）与 `runtimeVersion`（当前 DSH 版本）。
 * 只翻看得懂的形状；认不出即空串——绝不替宿主编原因、不编造要求。
 */
function incompatibleFactOf(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const facts: string[] = []
  for (const raw of value.slice(0, 2)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { name?: unknown; runtimeVersion?: unknown; requirements?: unknown }
    const requirements = entry.requirements
    if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) continue
    const runtime = typeof entry.runtimeVersion === 'string' && entry.runtimeVersion.trim() ? entry.runtimeVersion.trim() : ''
    const who = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : ''
    const keys = Object.keys(requirements as Record<string, unknown>).slice(0, 2)
    for (const key of keys) {
      const range = (requirements as Record<string, unknown>)[key]
      if (typeof range !== 'string' || !range.trim()) continue
      const what = key === 'engines.dsh' ? 'DSH' : key
      const current = runtime ? `（当前 ${runtime}）` : ''
      facts.push(`要求 ${who ? `${who} 的 ` : ''}${what} ${range.trim()}${current}`)
    }
  }
  return facts.slice(0, 2).join('；')
}

/**
 * 把「要求 ≥X（当前 Y）」补在宿主原话与既有建议之后（#195，验收：详情/面板点明要求与当前版本）。
 * 原文永远在前、建议在后；总长仍守 DETAIL_MAX_CHARS；没有可翻译的 incompatible[] 时一字不加。
 */
function withIncompatibleFact(error: Error & { detail?: string }, result: ManagerChangeResult): Error & { detail?: string } {
  if (managerCodeOf(result) !== 'incompatible-version') return error
  const fromError = result?.error && typeof result.error === 'object' ? (result.error as { incompatible?: unknown }).incompatible : undefined
  // 宿主给的 name / requirements / runtimeVersion 也是外部文本：照旧走唯一自由文本出口脱敏。
  const fact = sanitizeDetail(incompatibleFactOf(fromError !== undefined ? fromError : result?.packageResult?.incompatible))
  if (!fact) return error
  const said = typeof error.detail === 'string' ? error.detail : ''
  const room = DETAIL_MAX_CHARS - fact.length - 1
  if (room <= 0) return error
  const head = said.length > room ? said.slice(0, room) : said
  return withDetail(error, head ? `${head}；${fact}` : fact)
}

/**
 * 把一条「事实」补在详情尾部（原文永远在前、事实在后），总长守 DETAIL_MAX_CHARS。
 * 事实为空、或原文里已经带过同一句时不重复拼；事实本身放不下时宁可只留（截断的）原文，绝不越界。
 * #168 的移除后重装事实与 #236 的移除失败补偿共用这一份排版。
 */
function withTrailingFact(error: Error & { detail?: string }, fact: string): Error & { detail?: string } {
  if (!fact) return error
  const said = typeof error.detail === 'string' ? error.detail : ''
  if (said.includes(fact)) return error
  const room = DETAIL_MAX_CHARS - fact.length - 1
  if (room <= 0) return withDetail(error, said.slice(0, DETAIL_MAX_CHARS))
  const head = said.length > room ? said.slice(0, room) : said
  return withDetail(error, head ? `${head}；${fact}` : fact)
}

/**
 * 移除已成功、重装却没成（失败或超时）：在宿主原话之后补「目标包已被摘掉」这条事实与一条
 * 一定能用的重装命令（#168）。原文在前、本包补记在后，总长仍守 DETAIL_MAX_CHARS。
 * 命令为 null（插值不安全）时只说事实；原文里已经带过同一条命令时不再重复拼。
 *
 * #194：第二次安装也可能失败在「需要批准的构建脚本」上。这里按「原话 → 批准建议 → 移除事实」
 * 重新排版并**同时保住两条事实**——不能像从前那样从头截断原话而把尾部的批准建议切掉
 * （对抗审查 HARD：真机最常走的「更新已装包」正是这条路径）。
 */
function withRemovalFact(
  error: Error & { detail?: string },
  command: string | null,
  pendingBuilds: { names: string[]; approveCommand: string | null } = { names: [], approveCommand: null }
): Error & { detail?: string } {
  const said = stripPendingBuildsAdvice(typeof error.detail === 'string' ? error.detail : '')
  const withCommand = command !== null && !said.includes(command)
  const fact = withCommand ? `${REINSTALL_AFTER_REMOVAL_DETAIL} (${command})` : REINSTALL_AFTER_REMOVAL_DETAIL
  // 两条事实并存时先挑一条放得下的批准建议；候选顺序本身就是优先级（完整名单优先）。
  for (const advice of pendingBuildsAdviceCandidates(pendingBuilds.names, pendingBuilds.approveCommand)) {
    const room = DETAIL_MAX_CHARS - fact.length - advice.length - 2
    if (room < 0) continue
    const head = said.length > room ? said.slice(0, room) : said
    return withDetail(error, head ? `${head}；${advice}；${fact}` : `${advice}；${fact}`)
  }
  // 命令/事实本身就超预算时宁可丢补充事实也不越界：原文截到上限，绝不输出超长详情。
  return withTrailingFact(error, fact)
}

/**
 * 官方桌面版：把安装交给宿主进程内的插件管理器（`ctx.get('pluginManager')`）。
 *
 * 与命令行那条同政策：精确版本、官方源（走管理器的 registry 选项）、超时即终止（请求取消）。
 * 管理器**预期失败不 reject**——它 resolve 出 `application:'failed'` 加 `error`，所以成败只看
 * `application`，不看有没有抛异常；抛出来的只有「管理器自己挂了」这类意外。
 * 成败与失败原话按合同收成一行（截断脱敏），挂在抛出的错上由上层决定给谁看。
 *
 * 更新一个已在册的包要按宿主自己的 two-step 配方走：HMR 宿主里 `installBundle` 对已装包在跑
 * pnpm 之前就同步拒绝 `already-installed`（宿主自己的 next-step 表：先移除再装），本包若只调
 * `installBundle`，更新就永远停在这句拒绝上。所以命中这个拒绝时先按包名 removeBundle，再带新
 * requestId 装一次；别的失败一律不碰移除。四条宿主调用（首装、启用、移除、重装）共用配方里的
 * 一个超时额度；唯一例外是移除失败/超时后的在册补偿（#236）：它只发生在失败路径上，多一发
 * `setBundleEnabled` 与至多三次 `listBundles`，恢复调用额度取 max(剩余额度, 终止宽限)（另加一次
 * 收尾宽限），成功路径的总上界不变。
 */
async function runDesktopManager(recipe: InstallRecipe, parts: ExecutorParts): Promise<number | null> {
  try {
    const manager = part(parts.pluginManager ?? null) as {
      installBundle?: (
        spec: string,
        options: { requestId: string; registry?: string; approvedBuilds?: string[] }
      ) => unknown
      cancelInstall?: (requestId: string) => unknown
      removeBundle?: (name: string) => unknown
      /** 拓扑探测（#201）：已装包是否在宿主选中名单里、能不能移走。老宿主没有这格。 */
      listBundles?: () => unknown
      /** 恢复选中（#201）：官方桌面版用它把「装着但未选中」的 bundle 放回选中名单。 */
      setBundleEnabled?: (name: string, enabled: boolean) => unknown
    } | null
    if (!manager || typeof manager.installBundle !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
    // 取成常量再 `.call(manager, …)`：闭包里属性收窄会丢，this 也必须还是管理器自己。
    const installBundle = manager.installBundle
    const spec = managerSpecOf(recipe.pluginArgs)
    if (!spec) throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
    // 使用范围名取配方自己的（`installRecipe` 已在入口归一过），注入值只作老调用形状的兜底。
    const profileName = part(parts.profileName ?? null)
    const profileArg =
      typeof recipe.profileName === 'string' && recipe.profileName
        ? recipe.profileName
        : typeof profileName === 'string' && profileName
          ? profileName
          : 'desktop'
    const registry = part(parts.registryUrl ?? '') as unknown
    // 批准名单（#194）：执行器已归一带入；这里再归一一次，保证交给宿主的永远是安全包名数组。
    const approvedBuilds = normalizeApprovedBuilds(part(parts.approvedBuilds ?? []))
    const carrierCommand = carrierAddCommand(
      profileArg,
      spec,
      typeof registry === 'string' && registry ? registry : null
    )
    // 源不进参数数组（管理器不吃开关），走它自己的 registry 选项，取同一个注入值；
    // 批准名单（#194）同理走宿主选项：installBundle 会先 approveBuilds 再跑 pnpm。
    const optionsFor = (requestId: string): { requestId: string; registry?: string; approvedBuilds?: string[] } => {
      const options: { requestId: string; registry?: string; approvedBuilds?: string[] } = { requestId }
      if (typeof registry === 'string' && registry) options.registry = registry
      if (approvedBuilds.length > 0) options.approvedBuilds = approvedBuilds
      return options
    }
    // 一个配方额度管四条宿主调用（首装／启用／移除／重装）：每步只领剩下的，领完给 1ms 让 raceManager 走自己的超时收场。
    // #236 的失败补偿是唯一例外（只在移除失败/超时后发生，见 restoreEnabledAfterRemovalFailure）：恢复调用取
    // max(剩余额度, 终止宽限) 再给一次收尾宽限，免得「恢复还没写完就被判失败」——失败路径最多多约 6s，成功路径不变。
    const budgetMs = typeof recipe.timeoutMs === 'number' && recipe.timeoutMs > 0 ? recipe.timeoutMs : 0
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0
    const stepTimeoutMs = (): number => (budgetMs > 0 ? Math.max(1, deadline - Date.now()) : recipe.timeoutMs)
    // 取消能力是超时文案的前提（#184）：宿主没给 cancelInstall 时我们一次取消都没发过，
    // 文案不许写「已请求宿主取消」；还要提示这类宿主里超时的安装可能仍在后台跑完（被告知失败、实际装上）。
    const cancelInstall = typeof manager.cancelInstall === 'function' ? manager.cancelInstall : null
    const cancelInstallOf = async (requestId: string): Promise<string> => {
      if (cancelInstall === null) return 'not-running'
      try {
        const answer = (await cancelInstall.call(manager, requestId)) as { status?: unknown } | null
        const status = answer && typeof answer.status === 'string' ? answer.status : ''
        return status === 'cancelled' || status === 'too-late' ? status : 'not-running'
      } catch {
        return 'not-running'
      }
    }
    // 超时且已经点过取消。可能是「刚好装完、还没报到」的竞态，所以再给一个终止宽限期
    // 等它自己收尾，按它自己的结局判——不把已经落地的改动记成失败。
    const finishCall = async (
      running: Promise<ManagerChangeResult>,
      requestCancel: () => Promise<string>,
      timeoutDetail: string
    ): Promise<ManagerChangeResult> => {
      const outcome = await raceManager(running, stepTimeoutMs(), requestCancel)
      if (!outcome.timedOut) return outcome.value
      const settled = await settleWithin(running, TERMINATION_GRACE_MS)
      if (!settled) {
        void running.catch(() => {})
        throw failExec(withDetail(fail('install-failed'), timeoutDetail), { reason: 'timeout' })
      }
      return settled
    }
    const installTimeoutDetail = cancelInstall !== null ? INSTALL_TIMEOUT_DETAIL : INSTALL_TIMEOUT_NO_CANCEL_DETAIL
    const installOnce = async (): Promise<ManagerChangeResult> => {
      const requestId = randomUUID()
      const running = Promise.resolve(installBundle.call(manager, spec, optionsFor(requestId))) as Promise<ManagerChangeResult>
      return await finishCall(running, () => cancelInstallOf(requestId), installTimeoutDetail)
    }
    const failureOf = (result: ManagerChangeResult, application: string): Error => {
      if (application === 'cancelled')
        return failExec(withDetail(fail('install-failed'), '安装已被取消'), { reason: 'host-rejected', hostCode: 'cancelled' })
      // 失败原文优先取 packageResult.output（契约里 pnpm 的原话就在那格，error 只有 code/diagnostic）；
      // 取不到才退回 error 的短码。挑因与封顶口径同另两条路。
      const rawOutput = result && result.packageResult && typeof result.packageResult.output === 'string' ? result.packageResult.output : ''
      const said = rawOutput.trim()
        ? causeExcerptOf(rawOutput)
        : detailText(result && result.error !== undefined ? result.error : `application: ${application || 'unknown'}`)
      // 真跑过 pnpm 的失败要带真实退码出去（#R8）：exec 日志那格与另两条路由同口径，不许一律 null。
      const failure = fail('install-failed')
      const rawCode = result && result.packageResult ? result.packageResult.exitCode : undefined
      const coded = typeof rawCode === 'number' && Number.isInteger(rawCode) ? withExit(failure, rawCode) : failure
      const withHints = withIncompatibleFact(withManagerRetryHint(withDetail(coded, withManagerHint(result, said)), result, carrierCommand), result)
      // 需要批准的构建脚本（#194）：宿主把名单写进失败回包（pendingBuilds），本包负责点名与给批准路径；
      // 调用方带 approvedBuilds 重试时宿主先批准再跑 pnpm，不再永远卡在同一句失败上。
      // #207：把「宿主拒绝 / 真跑过 pnpm 的非零退出」分类挂到错上；宿主码只收稳定码形状。
      const hostCode = normalizeHostCode(managerCodeOf(result) || 'none')
      const exitCode = typeof rawCode === 'number' && Number.isInteger(rawCode) ? rawCode : null
      return failExec(
        withPendingBuildsHint(
          withHints,
          normalizeApprovedBuilds(result ? result.pendingBuilds : []),
          carrierApproveBuildsCommand(profileArg)
        ),
        exitCode === null ? { reason: 'host-rejected', hostCode } : { reason: 'nonzero-exit', exitCode },
      )
    }
    let result = await installOnce()
    let application = result && typeof result.application === 'string' ? result.application : ''
    if (!MANAGER_OK.includes(application)) {
      // 只有「宿主说这包已经装着了」才走两步；其余失败（含包名取不到、宿主没这能力）照旧失败。
      const targetName = managerSaidAlreadyInstalled(result) ? managerPackageNameOf(spec) : ''
      const removeBundle = manager.removeBundle
      if (!targetName || typeof removeBundle !== 'function') throw failureOf(result, application)
      // #201：宿主只对**选中**的 bundle 先取消选中再重载卸载。真机上有一批包装着、也在跑，
      // 却不在选中名单里（`dsh.profile.bundles` 没有它们）——直接 remove 会在活 fiber 判
      // `bundle-in-use`（2–3ms 就回），两步配方永远走不完。所以先探拓扑：不可移除就诚实拒绝；
      // 未选中就先用宿主能力恢复选中，再按常规两步走。老宿主没有探测/启用能力时退回旧行为。
      // 这次探测也把「移除前是否选中」留成快照：#236 里宿主的失败路径可能已经取消了选中，
      // 补偿逻辑只对「本来是开着的」负责（见下面移除步）。
      const topology = await probeManagerTopology(manager, targetName)
      // `not-removable` 这个码宿主在这条路径上没回过话，是包侧按宿主 `removable === false`
      // 的语义给的原因；人话格会照常拼「宿主原话不够用 → 本包建议」，不冒充宿主原话。
      if (topology !== null && topology.removable === false) {
        throw failureOf({ application: 'failed', error: { code: 'not-removable' } }, 'failed')
      }
      if (topology !== null && topology.enabled === false) {
        const setBundleEnabled = manager.setBundleEnabled
        if (typeof setBundleEnabled !== 'function') {
          // 真实原因是「宿主没有恢复选中的能力」，不是活 fiber 占用：给诚实原因 + 换通道命令，
          // 不合成 bundle-in-use 之类的宿主码（Spec 审查 HARD ②）。
          const error = withDetail(fail('install-failed'), ENABLE_UNSUPPORTED_DETAIL)
          throw failExec(withCarrierHint(error, carrierCommand), { reason: 'spawn-failed' })
        }
        const enabling = Promise.resolve(setBundleEnabled.call(manager, targetName, true)) as Promise<ManagerChangeResult>
        // 宿主 `setBundleEnabled` 走内部 `change()`，resolve 出 `{ application, error? }`（不 reject；
        // 契约见 `asar:…/dsh-plugin-manager/lib/index.js` 的 setBundleEnabled → change），
        // 所以成败看 application，与 installBundle/removeBundle 同一套判法。
        // 启用步没有可取消的安装请求：超时口径不谎称「已请求取消」，只说没继续安装。
        // 启用步的失败/超时同样属于「管理器通道走不通」，一律补载体 CLI 命令（Spec 审查 HARD ①）。
        const enabled = await finishCall(enabling, async () => 'not-running', ENABLE_TIMEOUT_DETAIL).catch(
          (error: unknown) => {
            throw withCarrierHint(error as Error & { detail?: string }, carrierCommand)
          }
        )
        const enableApplication = enabled && typeof enabled.application === 'string' ? enabled.application : ''
        if (!MANAGER_OK.includes(enableApplication)) {
          throw withCarrierHint(failureOf(enabled, enableApplication), carrierCommand)
        }
      }
      // 移除前留一份「用户是不是开着它」的在册快照：#201 的探测顺带给出这格，#236 的失败补偿
      // 只对「本来就在册」的包下手——装前就未在册的包，宿主移除失败时不会把它从在册名单里拿走
      // （未在册的 bundle 走不到「先取消选中」那半步），补偿反而会擅自改用户拓扑。
      const enabledBeforeRemoval = topology === null ? null : topology.enabled
      // 移除步刻意不请求取消；超时意味着「可能已经摘掉了、但没来得及重装」（#184）——要当场说清并给下一步。
      // 这一步的「手工命令」面板里可能拿不到（目标已不在 dependencies，读取器会判成源码安装、不给命令），
      // 所以把这条桌面 CLI 一定能用的重装命令直接写进人话格（spec = 包名@目标版本）。
      const removalTimeoutDetail =
        carrierCommand === null ? REMOVE_TIMEOUT_DETAIL : `${REMOVE_TIMEOUT_DETAIL} (${carrierCommand})`
      let removed: ManagerChangeResult
      try {
        // 创建 Promise 也放进 try：`removeBundle.call` 同步抛错（宿主实现异常）同样可能已经走过
        // 「先取消选中」那半步，必须走同一份补偿（Spec 审查 C1）。
        removed = await finishCall(
          Promise.resolve(removeBundle.call(manager, targetName)) as Promise<ManagerChangeResult>,
          async () => 'not-running',
          removalTimeoutDetail
        )
      } catch (error) {
        // 超时/宿主异常同样可能已经走过「先取消选中」那半步：照样补偿，原失败口径仍在前。
        // 同步抛错（宿主实现异常）不是带分类的 install-failed：先补分类再上抛，否则外层按
        // `detailText(error)` 重包会丢掉 detail，补偿事实就没了（Spec 审查 C1）。
        const fact = await restoreEnabledAfterRemovalFailure(manager, targetName, enabledBeforeRemoval, stepTimeoutMs)
        const failed =
          (error as { code?: unknown })?.code === 'install-failed'
            ? (error as Error & { detail?: string })
            : failExec(withDetail(fail('install-failed'), detailText(error)), { reason: 'unknown' })
        throw withTrailingFact(failed, fact)
      }
      const removalApplication = removed && typeof removed.application === 'string' ? removed.application : ''
      if (!MANAGER_OK.includes(removalApplication)) {
        const fact = await restoreEnabledAfterRemovalFailure(manager, targetName, enabledBeforeRemoval, stepTimeoutMs)
        throw withTrailingFact(failureOf(removed, removalApplication), fact)
      }
      result = await installOnce().catch((error) => {
        throw withRemovalFact(error as Error & { detail?: string }, carrierCommand)
      })
      application = result && typeof result.application === 'string' ? result.application : ''
      if (!MANAGER_OK.includes(application)) {
        throw withRemovalFact(failureOf(result, application), carrierCommand, {
          names: normalizeApprovedBuilds(result ? result.pendingBuilds : []),
          approveCommand: carrierApproveBuildsCommand(profileArg),
        })
      }
    }
    return 0
  } catch (error) {
    // #207：已经带分类的错误原样上抛；认不出的一律 reason=unknown 照记，不猜原因。
    if ((error as { code?: unknown })?.code === 'install-failed') {
      if (readInstallFail(error)) throw error
      throw failExec(error as Error, { reason: 'unknown' })
    }
    throw failExec(withDetail(fail('install-failed'), detailText(error)), { reason: 'unknown' })
  }
}


/** 普通 DSH 宿主：当前运行时 + CLI 的 JS 入口 + 参数数组，经宿主注入的子进程能力起进程。 */
async function runCliProcess(
  recipe: { pluginArgs: string[]; profileName: string; timeoutMs: number },
  parts: ExecutorParts
): Promise<number | null> {
  const executable = part(parts.runtimeExecutable) || (typeof process !== 'undefined' ? process.execPath : '')
  const execArgs =
    part(parts.runtimeExecArgs) ??
    (typeof process !== 'undefined' && Array.isArray(process.execArgv) ? (process.execArgv as string[]) : [])
  const entry = part(parts.cliEntry) ?? (await resolveCliEntry(typeof process !== 'undefined' && process.argv ? process.argv[1] : ''))
  if (!executable || !entry) throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const argv = [executable, ...execArgs, entry, 'plugin', '--profile', recipe.profileName, ...recipe.pluginArgs]
  const subprocess = part(parts.subprocess) as {
    spawn?: (opts: { argv: string[]; cwd?: string; stdio: unknown; graceMs: number }) => { done: Promise<{ exitCode?: number } | null> }
  } | null
  if (!subprocess || typeof subprocess.spawn !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const handle = subprocess.spawn({
    argv,
    cwd: (part(parts.profileDir) as string) || undefined,
    stdio: INSTALL_STDIO,
    graceMs: TERMINATION_GRACE_MS,
  })
  if (!handle || !handle.done || typeof handle.done.then !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const readOutput = (): string => causeExcerptOf(collectedOutputOf(handle))
  const canTerminate = typeof (handle as { terminate?: unknown }).terminate === 'function'
  const terminate = canTerminate ? (handle as unknown as { terminate: () => void }).terminate : null
  let terminated = false
  let terminateFailed = false
  // 结局只分三种：自己收尾 / 崩了（done reject） / 到点；先把 reject 折成事实，不要让它冒充超时。
  const settled = Promise.resolve(handle.done).then(
    (value) => ({ kind: 'settled' as const, value }),
    () => ({ kind: 'crashed' as const, value: null })
  )
  const timeoutMs = typeof recipe.timeoutMs === 'number' && recipe.timeoutMs > 0 ? recipe.timeoutMs : 0
  const TIMEOUT = Symbol('install-timeout')
  let timer: ReturnType<typeof setTimeout> | null = null
  const outcome = await (async () => {
    if (timeoutMs === 0) return await settled
    const deadline = new Promise<typeof TIMEOUT>((settle) => {
      timer = setTimeout(() => {
        try {
          if (terminate !== null) {
            terminate.call(handle)
            terminated = true
          }
        } catch {
          terminateFailed = true
        }
        settle(TIMEOUT)
      }, timeoutMs)
    })
    try {
      return await Promise.race([settled, deadline])
    } finally {
      if (timer !== null) {
        try {
          clearTimeout(timer)
        } catch {}
      }
    }
  })()
  if (outcome === TIMEOUT) {
    // 到点后宽限：宽限内自己以 0 收尾就算成功；否则超时是定局——即使它在被终止后落到非零/空退出码，
    // 也必须点名超时，不许退回「装失败」的通用兜底（#185：这就是用户看到的静默失败）。口径按
    // 「终止是否真发出 / 任务是否已收尾」选词，不许拿没发生的事实凑（Spec 审查）。
    const late = await settleWithin(settled, TERMINATION_GRACE_MS)
    if (late && late.kind === 'settled' && late.value && late.value.exitCode === 0) return 0
    const lateCode = late && late.kind === 'settled' ? (late.value && typeof late.value.exitCode === 'number' ? late.value.exitCode : null) : null
    const hint = timeoutHintOf(
      { terminated, ended: late !== null, terminateFailed },
      { terminated: CLI_TIMEOUT_DETAIL, noTerminate: SERVICE_TIMEOUT_NO_TERMINATE_DETAIL }
    )
    throw failExec(withDetail(withExit(fail('install-failed'), lateCode), withTimeoutHint(readOutput(), hint)), {
      reason: terminateFailed ? 'terminate-failed' : 'timeout',
      exitCode: lateCode,
    })
  }
  if (outcome.kind === 'crashed') {
    throw failExec(withDetail(fail('install-failed'), readOutput() || CLI_CRASHED_DETAIL), { reason: 'crashed' })
  }
  const code = outcome.value && typeof outcome.value.exitCode === 'number' ? outcome.value.exitCode : null
  // 抓取读数在退出后仍可读（宿主 subprocess 契约）：失败时把它挑成一句人话再上抛，
  // 上层按既有 message 通道给面板；挑不到就是空串，形状与从前一致。
  if (code !== 0) throw failExec(withDetail(withExit(fail('install-failed'), code), readOutput()), { reason: 'nonzero-exit', exitCode: code })
  return code
}

/**
 * 路由 → 跑法：三条路由与 README 第 4 节那张表一一对应，加路由只动这一处。
 * 起进程与两处宿主出口都只经宿主注入的零件，不经 shell、不用 PATH 上的命令名。
 */
type InstallRunner = (recipe: InstallRecipe, parts: ExecutorParts) => Promise<number | null>
const INSTALL_RUNNERS: Record<string, InstallRunner> = {
  'desktop-service': runDesktopService,
  'desktop-manager': runDesktopManager,
  'cli-process': runCliProcess,
}

/**
 * 真执行器：按核心给的配方跑安装（测试一律注入假零件，不走这里）。
 *
 * 路由只有三条，都由核心的 installRecipe 决定，本文件不按操作系统分支：
 *   - desktop-service：桌面宿主公开的 desktopPnpm.runPlugin(参数数组, 使用范围目录)；
 *   - desktop-manager：官方桌面版进程内的 pluginManager.installBundle(精确版本规格, 选项)；
 *   - cli-process：subprocess.spawn({ argv: [运行时, …运行时参数, CLI 入口, 'plugin', '--profile', 名, …参数] })。
 * 起进程只经宿主注入的子进程能力，不经 shell、不用 PATH 上的 `dsh` 命令名。
 */
export function createUpdateExecutor(parts: ExecutorParts = {}): (args?: { version?: string; profileName?: string | null; environmentKind?: EnvironmentKind; releaseChannel?: ReleaseChannel; approvedBuilds?: unknown }) => Promise<void> {
  return async function runInstall(args: { version?: string; profileName?: string | null; environmentKind?: EnvironmentKind; releaseChannel?: ReleaseChannel; approvedBuilds?: unknown } = {}): Promise<void> {
    const recipe = installRecipe({
      profileName: args.profileName ?? (part(parts.profileName ?? null) as string | null),
      version: String(args.version ?? ''),
      environmentKind: args.environmentKind ?? (part(parts.environmentKind ?? 'cli') as EnvironmentKind),
      releaseChannel: args.releaseChannel ?? (part(parts.releaseChannel ?? 'stable') as ReleaseChannel),
      targetPackageName: parts.targetPackageName === undefined ? undefined : (part(parts.targetPackageName) as string),
      registryUrl: parts.registryUrl === undefined ? undefined : (part(parts.registryUrl) as string),
      timeoutMs: parts.installTimeoutMs === undefined ? undefined : (part(parts.installTimeoutMs) as number),
    })
    // 一次调用携带的批准名单（#194）：归一后只对这次调用生效，不污染执行器的常驻零件。
    const approvedBuilds = normalizeApprovedBuilds(args.approvedBuilds)
    const partsForCall = approvedBuilds.length > 0 ? { ...parts, approvedBuilds } : parts
    const startedAt = Date.now()
    let exitCode: number | null = null
    try {
      if (!recipe) throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
      const runner = INSTALL_RUNNERS[recipe.route] ?? null
      if (!runner) throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
      exitCode = await runner(recipe, partsForCall)
      emitInstall(parts, recipe, true, exitCode, Date.now() - startedAt)
    } catch (error) {
      emitInstall(parts, recipe, false, (error as { exitCode?: number })?.exitCode ?? exitCode, Date.now() - startedAt)
      // 失败详情（宿主原话，已截断脱敏）随错误一起上抛，由上层决定给谁看；不塞进日志字段。
      // 不带原始调用栈：栈里全是本机绝对路径，零读者，且一旦有人读就会顺着越界。
      const detail = (error as { detail?: unknown })?.detail
      const wrapped = Object.assign(fail('install-failed'), {
        ...(typeof detail === 'string' && detail ? { detail } : {}),
      })
      // #207：执行器是失败事实的搬运工——路由分支挂上的分类原样带到上层（服务侧只落一行）。
      const facts = readInstallFail(error)
      throw facts ? attachInstallFail(wrapped, facts) : failExec(wrapped, { reason: 'unknown' })
    }
  }
}

// 内部复用导出（供单测断言子进程形态：数组、无 shell、不用 PATH 名、不按系统分支）。
export const __executorInternals = { INSTALL_STDIO, TERMINATION_GRACE_MS, CLI_PACKAGE_NAME, DESKTOP_HOST_PACKAGE_NAME }
