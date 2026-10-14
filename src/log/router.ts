/**
 * src/log/router.ts —— 按插件标识路由到落点。
 *
 * 为什么必须把「一个模块级变量」换成路由表：改造前的 `src/host.ts` 用 `let phoneLogCtx` 装落点，
 * 谁最后调一次 `createHostUpdate` 就覆盖谁（`deps.logCtx ?? phoneLogCtx`，单向、不清零）。
 * 同一份 DSH 里装两个用本更新系统的插件时，后装的那个会把前一个的日志行一并收走 ——
 * 日志互相覆盖的**根因就在这里**，不在文件格式。
 *
 * 现在：每个插件标识一个落点，各写各的；取不到落点就回 `null`（发射口按「丢弃并计数」处理），
 * **绝不回退到别人的 sink** —— 串台比丢行更坏：丢行看得出来，串台看不出来。
 *
 * 本文件零 Node 内建依赖（面板侧可以只 import 这里的类型）。
 */
import { createNoopSink, NOOP_SINK, type LogSink } from './sink.js'

export interface LogRouter {
  /** 绑定/覆盖某插件的落点。集成方重装面板时会再调一次，覆盖是预期行为（同一插件只有一份日志）。 */
  bind: (pluginId: string, sink: LogSink) => void
  /** 取该插件的落点；没绑过或已被解绑时回 null（调用方据此计数丢弃，不许回退）。 */
  resolve: (pluginId: string) => LogSink | null
  /** 解绑；带 sink 时只在当前绑的就是它时才摘（避免把后绑的误摘了）。 */
  unbind: (pluginId: string, sink?: LogSink) => boolean
  /** 当前绑定了几种插件标识（诊断与测试用）。 */
  size: () => number
  /** 当前绑定的插件标识（诊断用，顺序即绑定顺序）。 */
  pluginIds: () => string[]
}

export function createLogRouter(): LogRouter {
  const table = new Map<string, LogSink>()
  return {
    bind: (pluginId, sink) => {
      const key = typeof pluginId === 'string' ? pluginId : ''
      if (!key) return
      table.set(key, sink ?? NOOP_SINK)
    },
    resolve: (pluginId) => table.get(typeof pluginId === 'string' ? pluginId : '') ?? null,
    unbind: (pluginId, sink) => {
      const key = typeof pluginId === 'string' ? pluginId : ''
      const current = table.get(key)
      if (!current) return false
      if (sink && current !== sink) return false
      table.delete(key)
      return true
    },
    size: () => table.size,
    pluginIds: () => Array.from(table.keys()),
  }
}

/**
 * 本包在**本进程本副本**内的唯一路由表：宿主与共享零件（store 执行器）都从这里取落点。
 * 为什么不做成 globalThis 单例：多副本时每份副本各服务自己创建的实例，各自路由才是对的；
 * 真正需要跨副本共享的是「同一日志目录只许一个写者」那件事，它在 registry 上（那边才是 globalThis）。
 */
export const updateLogRouter: LogRouter = createLogRouter()

/** 无操作落点出口：给「明确知道不该写日志」的调用点用（例如清单不可用时的短路）。 */
export { createNoopSink }
