// src/host/phones.ts —— 宿主电话包边（#227 从 host.ts 搬出，蓝图 §4 host 域）。
//
// 管两件事：① 电话成功/失败行的唯一发点 loggedPhone / loggedChangelogPhone（一电话一条链）；
// ② 轮询抑制（#124）与失败心跳限速（#209）：状态轮询成功行零常驻、持续失败每 5 分钟一条。
// 注：蓝图说的「电话名拼装分支」仍留在 host/factory.ts 的 createHostUpdate 里——handler 直接闭包
// 引 readStatus / runInstall 等本地函数，抽出来只是多一层搬运，故按实现就近保留（票面记偏离）。

import { getSharedReader, type ReaderOverrides } from './capabilities.js'
import { readEnvForPanel, type PhoneEnvView } from './environment.js'

import { resolveUpdateConfig } from '../shared/config.js'
import { type ChangelogContentStatus } from '../core/changelog/parse.js'
import { buildDiag } from '../shared/diag.js'
import { hash8 } from '../shared/hash.js'
import { isCoreErrorCode } from '../shared/codes.js'
import { LOG_EVENT_CALL, LOG_EVENT_CALL_FAIL } from '../shared/log-events.js'
import { emitUpdateLog } from '../log/emit.js'
import { type UpdateLogHealth } from '../log/health.js'
import { type UpdateContractStatus } from '../log/manifest.js'
import { updateLogRouter } from '../log/router.js'
import { type LogSink } from '../log/sink.js'
import { withLogTrace } from '../log/trace.js'
import {
  visibleQueueFor,
  type VisibleQueue,
} from '../core/queue/model.js'

/** 核心错误码原样返回，外面世界的脏错误收敛为检查失败（码面真源在 src/shared/codes.ts，#141）。 */
function toUpdateErrorPayload(error: unknown): { error: string; errorKind: string } {
  const code = error && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : ''
  if (isCoreErrorCode(code)) return { error: code, errorKind: code }
  return { error: 'check-failed', errorKind: 'internal' }
}
/** 调用方显式要使用范围一栏时才算（默认不算，老回包形状不变）。 */
export function wantsEnv(args: Record<string, unknown>): boolean {
  return !!args && args['includeEnv'] === true
}
/** 电话回包里的可选队列视图（#15）：只在调用方显式要时才带，不传即与改造前一字不差。 */
export function queueArgsOf(args: Record<string, unknown>): { includeQueue: boolean; showOthers: boolean } {
  return {
    includeQueue: !!args && args['includeQueue'] === true,
    showOthers: !!args && args['showOthers'] === true,
  }
}
/**
 * 轮询抑制记忆（#124）：**每个宿主接线实例一份**，不是模块级——所以同进程的不同实例、
 * 不同测试互不干扰；一个实例的第一次 `updateStatus` 永远算「没有上一次可比」，照常落一行。
 */
export type StatusPollMemory = Map<string, string>

/**
 * 轮询失败限速记忆（#209）：与成功侧的 `StatusPollMemory` 分开——那边管「同状态不发」，
 * 这边管「持续失败不刷屏」。键是 (插件标识, 电话方法)，值是该键上一次落行的时刻。
 * 同样是**每个宿主接线实例一份**；轮询一恢复（下一次成功）就清记忆，于是「恢复」本身成为信号。
 */
export type PollFailureMemory = Map<string, number>

/**
 * 轮询失败心跳（#209）：同一 `(pluginId, method)` 的持续失败，首条立即、之后每 5 分钟一条。
 * 只按时间窗限速（不看错误码变没变）：600 次轮询失败落在 10 分钟内只 2 行、一小时最多 12 行
 * （正好是票面的验收口径）；窗口内错误码变了不额外落行，下一次心跳行会带当时的原因。
 * 这是常驻行「必须边沿触发」的唯一刻意例外：它记的是「持续失败」这个状态本身，按固定节拍
 * 补心跳；持续失败属于降级态，`CONTEXT.md` 的稳态噪声预算对它另设豁免（见该文件「噪声预算」）。
 */
const POLL_FAIL_HEARTBEAT_MS = 5 * 60_000

/** #209：限速记忆的键——同一插件 + 同一电话方法；发送判断与成功清记忆共用这一个构造。 */
function pollFailureKey(pluginId: string, method: string): string {
  return `${pluginId}\u0000${method}`
}

/** #209：轮询失败限速的时钟——优先用注入的 `now`（与宿主其余口径同一个钟），否则 Date.now。 */
function pollFailureClock(diagCtx: { readerOverrides?: ReaderOverrides } | undefined): number {
  try {
    const injected = diagCtx?.readerOverrides?.now
    if (typeof injected === 'function') {
      const value = injected()
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  } catch {
    /* 注入时钟坏了不回退成「不发」：用 Date.now 兜底，宁可多发也不吞失败 */
  }
  return Date.now()
}

/**
 * #209：轮询失败的发射裁决。true = 该发，并记下这次落行时刻；false = 同一 (插件标识, 电话方法)
 * 的持续失败且还在心跳窗口内（时钟倒退也按窗口内处理，宁少发不刷屏）。
 */
function shouldEmitPollFailure(
  memory: PollFailureMemory,
  pluginId: string,
  method: string,
  nowMs: number,
): boolean {
  const key = pollFailureKey(pluginId, method)
  const lastAt = memory.get(key)
  if (lastAt !== undefined && nowMs - lastAt < POLL_FAIL_HEARTBEAT_MS) return false
  memory.set(key, nowMs)
  return true
}

/**
 * 快照指纹（#124）：**只做进程内比较用，绝不入日志行**（脱敏面不因此扩大）。
 * 序列化不了（循环引用）就返回 null，等于「算不出，别抑制」——宁可多发一行，也不误吞一次状态变化。
 */
function statusFingerprint(snapshot: unknown): string | null {
  try {
    if (typeof snapshot === 'string') return snapshot
    const text = JSON.stringify(snapshot)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

export function checkExpiredError(): Error & { code: string } {
  return Object.assign(new Error('check-expired'), { code: 'check-expired' })
}

export function updateBusyError(): Error & { code: string } {
  return Object.assign(new Error('update-busy'), { code: 'update-busy' })
}
export function loggedPhone(
  method: string,
  kind: string,
  pluginId: string,
  fn: (args: Record<string, unknown>) => Promise<{
    snapshot: unknown
    manual?: string | null
    receipt?: unknown
    queue?: VisibleQueue | null
    env?: PhoneEnvView | null
    /** 可选：契约健康（#210），只有 updateStatus 带。 */
    logContract?: UpdateContractStatus
    /** 可选：日志健康（#212），只有 updateStatus 带；值来自真实接线状态，绝不含目录路径。 */
    logHealth?: UpdateLogHealth
    /** 可选：机读诊断（#21/#18），成功回包在快照里有失败任务时才带。 */
    diag?: unknown
  }>,
  diagCtx?: {
    config: ReturnType<typeof resolveUpdateConfig>
    readerOverrides: ReaderOverrides
  },
  /** 轮询抑制记忆（#124）：只有 `updateStatus` 用得上；不传即完全不抑制（默认等于现状）。 */
  pollMemory?: StatusPollMemory,
  /** 轮询失败限速记忆（#209）：只有 `updateStatus` 用得上；不传即完全不限速（默认等于现状）。 */
  failMemory?: PollFailureMemory,): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  /**
   * 一次电话 = 一条链（`0.16.4` 起，需 dsh-log 0.3.3 的 `store.trace()`）。
   * 链挂在**路由表给这个插件的落点**上：发射口只认与落点同源的链，所以 A 插件的链
   * 绝不会写到 B 插件的目录里。落点还没接上（自建实例是异步的）或集成方注入的是
   * 客户端实例时，`withLogTrace` 拿不到链，发射口退回原来的 `fire` —— 既有行为不变。
   */
  const sinkForPhone = (): LogSink | null => {
    try {
      return updateLogRouter.resolve(pluginId) ?? null
    } catch {
      return null
    }
  }

  async function runPhone(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t0 = Date.now()
    // 行统一从唯一发射口出去：落点按插件标识从路由表取（不再有「模块级最后一个落点」这种串台入口）。
    const emit = (level: string, event: string, fields: Record<string, unknown>): void => {
      emitUpdateLog(level, event, fields, { pluginId })
    }
    const safeArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    try {
      const out = await fn(safeArgs)
      const snapshot = out && out.snapshot ? out.snapshot : out
      // 轮询抑制（#124）：`updateStatus` 是每秒一次的既有轮询，**成功行一律不落常驻行**——
      // 名字与字段一字不动，只改「发不发」。依据：`host.call` 在 dsh-log 内置常驻名单里，
      // 集成方清单改不动它，所以只能在发射侧治（现场 934 KB/天里有 5309 行是它）。
      // 第一次轮询没有可比的上次，也不算事件：轮询的第一次观测不是事件（#125 装置的判据就是
      // 「N≥100 次轮询零常驻行」）；真状态事实走 `update.status.changed` 的边沿行与按需档 `update.poll`。
      // 只有「上次算得出指纹、这次算得出、且与上次不同」才留一行，供真发生变化时追溯。
      const isStatusPoll = method.endsWith('.updateStatus')
      // #209：轮询一恢复就清失败记忆——「恢复」本身就是信号，下次失败重新立即记一条。
      if (isStatusPoll && failMemory) failMemory.delete(pollFailureKey(pluginId, method))
      const fingerprint = isStatusPoll ? statusFingerprint(snapshot) : null
      const pollNoise = isStatusPoll && pollMemory !== undefined
      const previous = pollNoise ? (pollMemory.get(pluginId) ?? null) : null
      if (pollNoise && fingerprint !== null) pollMemory.set(pluginId, fingerprint)
      const pollSuppressed = pollNoise && fingerprint !== null && (previous === null || previous === fingerprint)
      if (!pollSuppressed) {
        // 成功事件 5 键基线（规格 #591 第 8 条）：旧 4 键加必填插件标识。
        // 成功形状不动（#21）：成功回包不因成功而带 diag——唯一例外是快照里躺着失败任务
        //（异步安装的失败在快照里，见下方 diag 透传）；无失败任务时旧面板逐字不变。
        emit('info', LOG_EVENT_CALL, { method, latencyMs: Date.now() - t0, ok: true, kind, pluginId })
      }
      return {
        ok: true,
        snapshot,
        manual: out && out.snapshot ? (out.manual ?? null) : null,
        receipt: out && out.receipt ? out.receipt : null,
        // 新增选填（#210）：契约健康——面板/诊断据此知道「字段门禁这轮有没有尺子」。
        ...(out && out.logContract ? { logContract: out.logContract } : {}),
        // 新增选填（#212）：日志健康——面板/诊断据此判定「日志是不是真的写不进去」。
        ...(out && out.logHealth ? { logHealth: out.logHealth } : {}),
        // 新增选填（#15）：调用方没要时不带该键，老调用形状不变。
        ...(out && out.queue ? { queue: out.queue } : {}),
        // 新增选填：使用范围一栏（只有调用方传了 includeEnv 才带，老调用形状不变）。
        ...(out && out.env ? { env: out.env } : {}),
        // 新增选填（#156 第四轮）：异步安装的失败藏在快照任务里——此时成功回包也带机读诊断，
        // 因为「哪家的哪个包被拦下」只有宿主知道，面板拿插件标识猜不出来（B4）。无失败任务即不带。
        ...(out && out.diag ? { diag: out.diag } : {}),
      }
    } catch (error) {
      const payload = toUpdateErrorPayload(error)
      // #209：常驻 warn 限速——状态轮询失败不能再每秒一行（断网时一天上万行，把真信号埋掉）。
      // 同一 (pluginId, method) 首条立即、持续失败每 5 分钟一条心跳；恢复（下一次成功）清记忆。
      // 非轮询电话完全不受影响（#124 的「一次失败电话一条」口径不变；批量电话另有同码去重）。
      const pollFailureThrottled =
        method.endsWith('.updateStatus') &&
        failMemory !== undefined &&
        !shouldEmitPollFailure(failMemory, pluginId, method, pollFailureClock(diagCtx))
      if (!pollFailureThrottled) {
        // 失败事件 4 键基线（规格 #591 第 8 条）：旧 3 键加必填插件标识。
        emit('warn', LOG_EVENT_CALL_FAIL, { method, kind, error: payload.error, errorHash: hash8(String((error as Error)?.message || payload.error)), pluginId })
      }
      // 失败证据闭包（#21，#18 契约实现）：失败回包加可选 diag，只增不改。
      // best-effort：组装失败即按无 diag 的旧形状返回（新面板×旧载荷仍为正常缺省）。
      let diag: Record<string, unknown> | undefined
      try {
        const cfg = diagCtx?.config
        const overrides = diagCtx?.readerOverrides ?? {}
        const envRaw = (overrides as ReaderOverrides)?.environmentKind
        const runningRaw = (overrides as ReaderOverrides)?.runningVersion
        const built = buildDiag({
          errorCode: payload.error,
          phoneKind: kind,
          error,
          args: safeArgs,
          targetPackageName: cfg?.targetPackageName,
          registryUrl: cfg?.registryUrl,
          runningVersion: typeof runningRaw === 'string' ? runningRaw : undefined,
          latestVersion: undefined,
          environmentKind: typeof envRaw === 'string' ? envRaw : undefined,
          latencyMs: Date.now() - t0,
        })
        if (built && typeof built === 'object') diag = built as unknown as Record<string, unknown>
      } catch {
        diag = undefined
      }
      // 失败也带使用范围与队列（#45：调用方显式要才带，老调用形状不变；best-effort，读不到即省略）。
      // 读数只取一次：取不到则 env 与 queue 一并省略（两者消费互相独立，互不挡路）。
      let failReader: Awaited<ReturnType<typeof getSharedReader>> | null = null
      try {
        const failConfig = diagCtx?.config
        const failOverrides = (diagCtx?.readerOverrides ?? {}) as ReaderOverrides
        if (failConfig && (wantsEnv(safeArgs) || queueArgsOf(safeArgs).includeQueue)) {
          failReader = await getSharedReader(pluginId, failConfig, {
            ...failOverrides,
            profileDir:
              safeArgs && safeArgs.profileDir ? String(safeArgs.profileDir) : failOverrides.profileDir,
          })
        }
      } catch {
        failReader = null
      }
      let envPatch: Record<string, unknown> = {}
      try {
        if (failReader && wantsEnv(safeArgs)) {
          const env = await readEnvForPanel(failReader)
          if (env) envPatch = { env }
        }
      } catch {
        envPatch = {}
      }
      let queuePatch: Record<string, unknown> = {}
      try {
        const { includeQueue, showOthers } = queueArgsOf(safeArgs)
        if (failReader && includeQueue) {
          const requestIdForQueue =
            safeArgs && typeof safeArgs.requestId === 'string' ? String(safeArgs.requestId) : undefined
          const q = visibleQueueFor(await failReader.readQueuePruned(), pluginId, showOthers, requestIdForQueue)
          if (q) queuePatch = { queue: q }
        }
      } catch {
        queuePatch = {}
      }
      return { ok: false, ...payload, ...(diag ? { diag } : {}), ...envPatch, ...queuePatch }
    }
  }

  return async function (args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withLogTrace(sinkForPhone(), () => runPhone(args))
  }
}
/**
 * 更新日志电话的包边（#38）：成功只回 version + markdown（无路径、无快照），
 * 失败复用 error / errorKind 体系 + 可选 diag；日志沿用 host.call / host.call.fail 基线。
 */
export function loggedChangelogPhone(
  method: string,
  pluginId: string,
  fn: (args: Record<string, unknown>) => Promise<{
    version: string
    markdown: string | null
    status: ChangelogContentStatus
    cached: boolean
  }>,
  diagCtx?: {
    config: ReturnType<typeof resolveUpdateConfig>
    readerOverrides: ReaderOverrides
  },
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  // 与 `loggedPhone` 同一条纪律：一次电话 = 一条链（0.16.4 起）。
  const sinkForPhone = (): LogSink | null => {
    try {
      return updateLogRouter.resolve(pluginId) ?? null
    } catch {
      return null
    }
  }

  async function runChangelogPhone(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t0 = Date.now()
    const emit = (level: string, event: string, fields: Record<string, unknown>): void => {
      emitUpdateLog(level, event, fields, { pluginId })
    }
    const safeArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    try {
      const out = await fn(safeArgs)
      emit('info', LOG_EVENT_CALL, { method, latencyMs: Date.now() - t0, ok: true, kind: 'update-changelog', pluginId })
      return { ok: true, version: out.version, markdown: out.markdown, status: out.status, cached: out.cached }
    } catch (error) {
      const payload = toUpdateErrorPayload(error)
      emit('warn', LOG_EVENT_CALL_FAIL, { method, kind: 'update-changelog', error: payload.error, errorHash: hash8(String((error as Error)?.message || payload.error)), pluginId })
      let diag: Record<string, unknown> | undefined
      try {
        const cfg = diagCtx?.config
        const overrides = diagCtx?.readerOverrides ?? {}
        const envRaw = (overrides as ReaderOverrides)?.environmentKind
        const runningRaw = (overrides as ReaderOverrides)?.runningVersion
        const built = buildDiag({
          errorCode: payload.error,
          phoneKind: 'update-changelog',
          error,
          args: safeArgs,
          targetPackageName: cfg?.targetPackageName,
          registryUrl: cfg?.registryUrl,
          runningVersion: typeof runningRaw === 'string' ? runningRaw : undefined,
          latestVersion: undefined,
          environmentKind: typeof envRaw === 'string' ? envRaw : undefined,
          latencyMs: Date.now() - t0,
        })
        if (built && typeof built === 'object') diag = built as unknown as Record<string, unknown>
      } catch {
        diag = undefined
      }
      return { ok: false, ...payload, ...(diag ? { diag } : {}) }
    }
  }

  return async function (args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withLogTrace(sinkForPhone(), () => runChangelogPhone(args))
  }
}
