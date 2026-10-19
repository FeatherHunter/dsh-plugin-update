/**
 * src/log/panel-client.ts —— 面板侧客户端日志壳（#214 起两套面板共用一份，#208 后收敛）。
 *
 * 单面板（panel.ts）与批量面板（panel-batch.ts）的失败证据口径必须一致：
 * 挂载校验失败、渲染失败、轮询传输失败、全局兜底共用同一套字段与去重；动作行只留
 * 「动作 + 成败 + 稳定错误码 + 耗时」。这份壳把「读调用方选项 → 决定自建/复用/关闭通道 →
 * 落行 → 去重 → 冲刷 → 销毁」收在一处，面板只负责在各自的校验分支上给 kind。
 *
 * 浏览器安全：本文件零 `node:` 依赖（只引客户端通道与 djb2 短哈希），可被面板打包。
 */
import { createClientLogChannel, type ClientLogChannel, type ClientLogEvent } from './client-queue.js'
import { hash8 } from '../shared/hash.js'

/** 调用方对客户端日志通道的三种表态：传通道复用、传 null 关闭、不传自建。 */
export interface PanelClientLogOptions {
  channel?: ClientLogChannel | null
  /** 写进 update.panel.mount 的 mode（入口件/HTTP 直挂/批量面板各报各的）。 */
  mount?: string
}

export type PanelRenderFailPhase = 'mount' | 'paint' | 'poll' | 'global'

export interface PanelClientLogShellOptions {
  /** 面板选项里的 clientLog 原样传入（可能在 options 非法时为 undefined）。 */
  clientLog?: PanelClientLogOptions | null
  /** 传输函数；不是函数时不建通道（调用方校验会如实抛并留一行）。 */
  call?: ((phoneName: string, args: Record<string, unknown>) => Promise<unknown>) | null
  /** `<前缀>.logAppend` 电话名；前缀非法时由调用方用兜底前缀派生。 */
  logAppendPhone: string
  /** 批量面板的传输回包可能是任何值：非对象按空对象交回（由客户端通道记降级）。 */
  coerceReply?: boolean
}

export interface PanelClientLogShell {
  /** 当前通道（没有就是 null）：面板不需要直接操作它，保留给诊断与测试。 */
  readonly channel: ClientLogChannel | null
  /** 通道是否由本壳自建（自建才在卸载/挂载失败时销毁）。 */
  readonly owned: boolean
  /** 调用方给的 mount 名（空串表示没给，挂载行落实际 mode）。 */
  readonly mountName: string
  errorTextOf(err: unknown): string
  /** 客户端行出口：没有通道就什么都不做（调用点不必自己判空）。 */
  log(level: string, event: ClientLogEvent, fields: Record<string, unknown>): void
  /** 渲染/轮询/全局兜底失败：同 phase+kind+errorHash 60 秒内至多一条。 */
  emitRenderFail(phase: PanelRenderFailPhase, kind: string, message: string): void
  /** 挂载校验失败：先落一行（必定落，挂载一次只有一次）再冲刷；自建通道冲完销毁。 */
  failMount(kind: string, message: string): void
  /** 客户端通道按原因计的丢弃总数（进 copy-diag 计数段）。 */
  droppedRows(): number
  /** 全局兜底（mount 时装、unmount 时摘）：只落指纹不落原文。 */
  installGlobalHandlers(): void
  removeGlobalHandlers(): void
  /** 卸载：摘全局监听 + 自建通道 dispose（注入通道不销毁）。 */
  dispose(): void
}

const RENDER_FAIL_DEDUPE_MS = 60_000

export function createPanelClientLogShell(options: PanelClientLogShellOptions): PanelClientLogShell {
  const option = options.clientLog
  const disabled = option === null
  const mountName =
    option && typeof option === 'object' && typeof option.mount === 'string' && option.mount ? option.mount : ''
  let channel: ClientLogChannel | null =
    option && typeof option === 'object' && option.channel ? option.channel : null
  let owned = false

  // 自建通道：调用方没给、也没明确关掉、且传输可用时。老宿主没有 `<前缀>.logAppend` 电话，
  // 投递失败由通道自己退避重试后丢弃计数，一个异常都不往上冒。
  if (!channel && !disabled && typeof options.call === 'function') {
    const call = options.call
    try {
      channel = createClientLogChannel({
        call: options.coerceReply
          ? async (phoneName, args) => {
              const reply = await call(phoneName, args)
              return reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : {}
            }
          : (async (phoneName, args) => {
              return (await call(phoneName, args)) as Record<string, unknown>
            }),
        phoneName: options.logAppendPhone,
      })
      owned = true
    } catch {
      channel = null
    }
  }

  function errorTextOf(err: unknown): string {
    try {
      if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
        return (err as { message: string }).message
      }
      if (typeof err === 'string') return err
      return String(err ?? '')
    } catch {
      return ''
    }
  }

  function log(level: string, event: ClientLogEvent, fields: Record<string, unknown>): void {
    const current = channel
    if (!current) return
    try {
      current.emit(level, event, fields)
    } catch {
      // 报日志永不外抛：日志坏了不挡面板。
    }
  }

  const renderFailSeen = new Map<string, number>()
  function emitRenderFail(phase: PanelRenderFailPhase, kind: string, message: string): void {
    const errorHash = hash8(message)
    if (phase !== 'mount') {
      const key = `${phase}|${kind}|${errorHash}`
      const nowMs = Date.now()
      const last = renderFailSeen.get(key)
      if (last !== undefined && nowMs - last < RENDER_FAIL_DEDUPE_MS) return
      renderFailSeen.set(key, nowMs)
    }
    log('error', 'update.panel.render.fail', { phase, kind, errorHash })
  }

  function failMount(kind: string, message: string): void {
    emitRenderFail('mount', kind, message)
    // 挂载已失败：先催冲刷，冲完把自建通道收掉——不留 visibilitychange 监听，也不留半条通道。
    const current = channel
    if (!current) return
    try {
      void Promise.resolve(current.flush())
        .catch(() => undefined)
        .then(() => {
          if (owned) current.dispose()
        })
    } catch {
      // 冲刷失败也不影响抛错路径。
    }
  }

  function droppedRows(): number {
    try {
      const map = channel?.droppedByReason?.() ?? {}
      let total = 0
      for (const key of Object.keys(map)) {
        const n = map[key]
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) total += n
      }
      return total
    } catch {
      return 0
    }
  }

  let removeGlobalHandlers: (() => void) | null = null
  function installGlobalHandlers(): void {
    const g = globalThis as unknown as {
      addEventListener?: (type: string, fn: (event: unknown) => void) => void
      removeEventListener?: (type: string, fn: (event: unknown) => void) => void
    }
    if (typeof g.addEventListener !== 'function') return
    const onError = (event: unknown): void => {
      const msg = errorTextOf((event as { message?: unknown } | null)?.message ?? event)
      emitRenderFail('global', 'uncaught', msg || 'uncaught-error')
    }
    const onRejection = (event: unknown): void => {
      const reason = (event as { reason?: unknown } | null)?.reason
      emitRenderFail('global', 'unhandled', errorTextOf(reason) || 'unhandled-rejection')
    }
    let registered = false
    try {
      g.addEventListener('error', onError)
      g.addEventListener('unhandledrejection', onRejection)
      registered = true
    } catch {
      registered = false
    }
    if (!registered) return
    removeGlobalHandlers = () => {
      try {
        g.removeEventListener?.('error', onError)
      } catch {
        // 摘不掉也不挡卸载。
      }
      try {
        g.removeEventListener?.('unhandledrejection', onRejection)
      } catch {
        // 摘不掉也不挡卸载。
      }
    }
  }

  function removeGlobalHandlersNow(): void {
    removeGlobalHandlers?.()
    removeGlobalHandlers = null
  }

  function dispose(): void {
    removeGlobalHandlersNow()
    if (!owned || !channel) return
    try {
      channel.dispose()
    } catch {
      // 卸载不因日志通道失败而失败。
    }
  }

  return {
    get channel() {
      return channel
    },
    get owned() {
      return owned
    },
    get mountName() {
      return mountName
    },
    errorTextOf,
    log,
    emitRenderFail,
    failMount,
    droppedRows,
    installGlobalHandlers,
    removeGlobalHandlers: removeGlobalHandlersNow,
    dispose,
  }
}
