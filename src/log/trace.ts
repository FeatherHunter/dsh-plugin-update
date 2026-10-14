/**
 * src/log/trace.ts —— 宿主侧的链上下文（`0.16.4` 起）。
 *
 * 为什么需要它：本包的多步链全在宿主侧（查 → 判 → 装 → 验），而 dsh-log 的
 * `store.log(level, event, fields)` 是三参入口、不负责建链 —— 自动建链长在它的**客户端**
 * 写入路径上，宿主侧走不到，所以此前 `--trace` 对本包自建落点的行一行都命中不了。
 * 0.3.3 起上游补了 `store.trace()`：建链、`child()` 换 span、保留字冲突搬进 `fields._shadow`。
 *
 * 本文件只补上游没做的那一件事：**把「当前是哪条链」变成一次电话调用内可见的环境**，
 * 好让唯一发射口不必把 trace 当参数一路手抄下去（手抄就会有人漏抄，而漏抄的那条恰好
 * 会在第三方交日志时才被发现 —— 与 `emit.ts` 开头同一个理由）。
 *
 * 为什么用 `AsyncLocalStorage` 而不是模块级变量：一个进程里可能同时跑着轮询与安装两条链，
 * 还可能有多个插件 —— 模块级变量会让它们互相串味，而串味正是 #126 要根除的东西。
 *
 * 三条纪律：
 *   1. **认源**：环境里的链只对**建它的那个落点**生效（`currentLogTraceFor(sink)` 比对象同一性）。
 *      不认源就可能把 A 插件的行写进 B 插件的目录 —— 那比丢一行坏得多。
 *   2. **不改变既有行为**：环境里没有链（集成方注入客户端实例、降级落点、0.3.2 及更早的 store、
 *      面板侧 `logAppend` 的行）时，发射口照旧 `sink.fire`，一个字节都不变。
 *   3. **永不外抛**：取链失败按「没有链」处理（本文件对外只回句柄或 null）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { LogSink, LogTraceHandle } from './sink.js'

/** 环境里存的东西：落点 + 它的链（链是懒取的，建库是异步的，电话可能先到）。 */
interface TraceScope {
  sink: LogSink
  trace: LogTraceHandle | null
  resolved: boolean
}

const storage = new AsyncLocalStorage<TraceScope>()

/**
 * 在一条链里跑一段（同步或异步都行：`AsyncLocalStorage` 跟着 await 走）。
 * `sink` 取不到（没有落点）时原样执行 `fn` —— 没有落点就没有链，但主流程照跑。
 */
export function withLogTrace<T>(sink: LogSink | null | undefined, fn: () => T): T {
  if (!sink) return fn()
  const scope: TraceScope = { sink, trace: null, resolved: false }
  return storage.run(scope, fn)
}

/**
 * 取当前环境里**属于这个落点**的链；不属于（或压根没有）时回 null。
 * 懒取：第一次问的时候落点可能还没接上（自建 dsh-log 是异步的，`createHostUpdate` 是同步契约），
 * 接了之后 `trace()` 才有东西可给；取不到就记住「没有」，不反复问。
 */
export function currentLogTraceFor(sink: LogSink): LogTraceHandle | null {
  let scope: TraceScope | undefined
  try {
    scope = storage.getStore()
  } catch {
    return null
  }
  if (!scope || scope.sink !== sink) return null
  if (!scope.resolved) {
    scope.resolved = true
    try {
      scope.trace = typeof sink.trace === 'function' ? sink.trace() : null
    } catch {
      scope.trace = null
    }
  }
  return scope.trace
}

/**
 * 当前链的下一条：换 `spanId`、`seq` 从 0 起（与 dsh-log `child()` 同语义），
 * 用于「一次电话里的一个步骤」——同一个 `traceId` 下能分出步骤边界。
 * 没有链时原样执行（调用点不必先问）。
 */
export function withLogTraceStep<T>(fn: () => T): T {
  const scope = safeStore()
  if (!scope) return fn()
  const current = currentLogTraceFor(scope.sink)
  if (!current) return fn()
  let next: LogTraceHandle
  try {
    next = current.child()
  } catch {
    return fn()
  }
  return storage.run({ sink: scope.sink, trace: next, resolved: true }, fn)
}

function safeStore(): TraceScope | undefined {
  try {
    return storage.getStore()
  } catch {
    return undefined
  }
}
