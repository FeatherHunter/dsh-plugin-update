/**
 * src/log/client-queue.ts —— 客户端日志通道（#122）：面板侧唯一的报日志出口。
 *
 * 为什么需要它：面板跑在浏览器闭包里，**_必须**用浏览器闭包里能找到的东西。落盘是宿主的事，
 * 而 dsh-log 的引擎在 Node 那半边；唯一能跨过去的现成通道就是本包已经在用的电话（`<prefix>.logAppend`）。
 * 所以这里只做三件事，把「客户端行 → 宿主落盘」这段路修平：
 *   1. **有界**：环形缓冲（缺省 200 行），满了挤掉最老的（日志要留最近状态，不是最先状态），挤掉的计入丢弃。
 *   2. **不吵**：按批发（缺省一批 50 行、间隔 1 秒），失败退避重试（缺省 2 次），到点即丢并计数。
 *      页面切到后台（`visibilitychange` → hidden）立刻冲刷一次，避免「用户关掉标签页，最后几行没了」。
 *   3. **永不外抛、永不挡更新**：电话没接上、宿主没这个电话、回包形状不对、投递抛错 —— 全部只计数。
 *      丢弃计数可读（`dropped()`），这是「日志丢了」唯一诚实的说法。
 *
 * 本文件零 Node 内建依赖、零全局副作用：计时器与可见性端口都可注入（测试不依赖 jsdom），
 * 缺省才去 `globalThis` 上取。行只带稳定码与枚举值，人话由渲染层产出（ADR-0006）。
 */

/** 一行客户端日志（与宿主半区 `update.log` 的五键行不同：没有 ts 之外的封装，ts 由引擎另盖）。 */
export interface ClientLogRow {
  level: string
  event: string
  fields: Record<string, unknown>
  /** 发生时刻（毫秒）。宿主用它判 stale，**不落盘**（落盘时间戳由引擎盖，行里只有一个时间）。 */
  ts: number
}

/** 计时器端口（浏览器/Node 都认；测试给假件即确定性）。 */
export interface ClientLogTimer {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

/** 可见性端口（`document` 的最小子集；测试给假件）。 */
export interface ClientLogVisibility {
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
  visibilityState?: string
  hidden?: boolean
}

export interface ClientLogChannelOptions {
  /** 宿主电话通道（面板侧唯一的宿主接触面：与面板 `call` 同一个函数）。 */
  call: (phoneName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** 日志电话名（`<prefix>.logAppend`；从 buildLogAppendPhoneName 派生，不写字面量）。 */
  phoneName: string
  /** 环形缓冲容量（缺省 200）。 */
  maxQueue?: number
  /** 一批最多几行（缺省 50）。 */
  batchSize?: number
  /** 定时冲刷间隔毫秒（缺省 1000）。 */
  flushIntervalMs?: number
  /** 失败重试次数（缺省 2：首发 + 2 次重试共 3 次尝试）。 */
  maxRetries?: number
  /** 重试退避毫秒序列（缺省 [250, 1000]；不足时取最后一项）。 */
  retryDelaysMs?: number[]
  /** 单次发送超时毫秒（缺省 5000；<=0 即不设超时）。超时按传输失败走重试。 */
  sendTimeoutMs?: number
  /** 计时器端口：传 null 即不排定时（只剩手动 flush），不传即取 globalThis。 */
  timer?: ClientLogTimer | null
  /** 可见性端口：传 null 即不听 visibilitychange，不传即取 globalThis.document。 */
  visibility?: ClientLogVisibility | null
  /** 时钟（缺省 Date.now）。 */
  now?: () => number
  /** 丢弃回调（诊断用；抛错只吞，永不外抛）。 */
  onDrop?: (row: ClientLogRow | null, reason: string) => void
}

export interface ClientLogChannel {
  /** 报一行（level 缺省 info）。任何环境下都不外抛。 */
  emit: (level: string, event: string, fields: Record<string, unknown>) => void
  /** 立刻冲刷一批（在途时直接返回；永不 reject）。 */
  flush: () => Promise<void>
  /** 还在缓冲里的行数。 */
  pending: () => number
  /** 丢弃行数（缓冲挤掉 + 重试用尽 + 没通道 + 宿主回包说丢了几行）。 */
  dropped: () => number
  /** 已交出去的行数（宿主回包 accepted 累加，不是「已落盘」）。 */
  sent: () => number
  /** 通道可用否（有 call + 有电话名 + 没销毁）。 */
  enabled: () => boolean
  /** 停定时、听断可见性、清缓冲（缓冲里的行计入丢弃）。 */
  dispose: () => void
}

export const CLIENT_LOG_MAX_QUEUE = 200
export const CLIENT_LOG_BATCH_SIZE = 50
export const CLIENT_LOG_FLUSH_MS = 1000
export const CLIENT_LOG_MAX_RETRIES = 2
export const CLIENT_LOG_RETRY_DELAYS_MS = [250, 1000]
export const CLIENT_LOG_SEND_TIMEOUT_MS = 5000

/** 行级别词表（与 dsh-log 同一套；别的值一律不许进日志）。 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevelName = (typeof LOG_LEVELS)[number]

/**
 * 客户端侧允许经 `logAppend` 交回宿主的事件白名单（协议面）。
 * 为什么要白名单：这条路是**客户端**说的话，不给白名单就能伪造 `update.install.exec` 这类宿主事实，
 * 日志的可信度当场归零。清单（`event-list.update.json`）仍管字段形状，这里只管「谁有资格说这件事」。
 */
export const CLIENT_LOG_EVENTS = [
  'update.panel.mount',
  'update.panel.action',
  'update.panel.render.fail',
  'update.panel.state',
  'update.lang.applied',
] as const
export type ClientLogEvent = (typeof CLIENT_LOG_EVENTS)[number]

/** 判据：这个名字是不是客户端有权交回来的事件。 */
export function isClientLogEvent(name: unknown): boolean {
  if (typeof name !== 'string') return false
  for (const e of CLIENT_LOG_EVENTS) {
    if (e === name) return true
  }
  return false
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return n > 0 ? n : fallback
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return n >= 0 ? n : fallback
}

/** 取 globalThis 上的计时器（浏览器 setTimeout/clearTimeout；Node 同名同理）。 */
export function resolveClientLogTimer(): ClientLogTimer | null {
  try {
    const g = globalThis as unknown as Record<string, unknown>
    const set = g['setTimeout']
    const clear = g['clearTimeout']
    if (typeof set === 'function' && typeof clear === 'function') {
      return {
        set: (fn, ms) => (set as (fn: () => void, ms: number) => unknown).call(g, fn, ms),
        clear: (handle) => (clear as (handle: unknown) => void).call(g, handle),
      }
    }
  } catch {
    /* 没有计时器就没有自动冲刷，手动调 flush 照常 */
  }
  return null
}

/** 取 globalThis.document 上的可见性（无 DOM 即 null：不听事件，也不报错）。 */
export function resolveClientLogVisibility(): ClientLogVisibility | null {
  try {
    const doc = (globalThis as unknown as { document?: ClientLogVisibility }).document
    if (doc && typeof doc.addEventListener === 'function') return doc
  } catch {
    /* 读不到即当没有 DOM */
  }
  return null
}

/**
 * 建客户端日志通道。`call`/`phoneName` 缺一即「没通道」：行照样被计数丢弃，一个异常都不抛
 * —— 面板在宿主电话缺失（老宿主、HTTP 网关没这个路由）时应当照常可用。
 */
export function createClientLogChannel(options: ClientLogChannelOptions): ClientLogChannel {
  const call = options && typeof options.call === 'function' ? options.call : null
  const phoneName = options && typeof options.phoneName === 'string' ? options.phoneName : ''
  const capacity = positiveInt(options?.maxQueue, CLIENT_LOG_MAX_QUEUE)
  const batchSize = positiveInt(options?.batchSize, CLIENT_LOG_BATCH_SIZE)
  const flushMs = positiveInt(options?.flushIntervalMs, CLIENT_LOG_FLUSH_MS)
  const maxRetries = nonNegativeInt(options?.maxRetries, CLIENT_LOG_MAX_RETRIES)
  const retryDelays =
    Array.isArray(options?.retryDelaysMs) && options.retryDelaysMs.length > 0
      ? options.retryDelaysMs
      : CLIENT_LOG_RETRY_DELAYS_MS
  const sendTimeoutMs = options?.sendTimeoutMs === undefined ? CLIENT_LOG_SEND_TIMEOUT_MS : Number(options.sendTimeoutMs)
  const timer = options?.timer === undefined ? resolveClientLogTimer() : options.timer
  const visibility = options?.visibility === undefined ? resolveClientLogVisibility() : options.visibility
  const now = typeof options?.now === 'function' ? options.now : (): number => Date.now()
  const onDrop = typeof options?.onDrop === 'function' ? options.onDrop : null

  // 环形缓冲：定长数组 + 头指针 + 计数（不 shift 数组，容量内零重分配）。
  const slots: (ClientLogRow | null)[] = new Array<ClientLogRow | null>(capacity).fill(null)
  let head = 0
  let count = 0
  let dropped = 0
  let sent = 0
  let disposed = false
  let scheduled: unknown = null
  let inFlight = false

  function noteDrop(row: ClientLogRow | null, reason: string): void {
    dropped++
    if (!onDrop) return
    try {
      onDrop(row, reason)
    } catch {
      /* 诊断回调自己坏了不能连坐 */
    }
  }

  function push(row: ClientLogRow): void {
    if (count === capacity) {
      // 满了挤掉最老的：日志要留最近状态；挤掉的那行如实计入丢弃。
      const evicted = slots[head]
      slots[head] = row
      head = (head + 1) % capacity
      noteDrop(evicted, 'overflow')
      return
    }
    slots[(head + count) % capacity] = row
    count++
  }

  function shift(): ClientLogRow | null {
    if (count === 0) return null
    const row = slots[head]
    slots[head] = null
    head = (head + 1) % capacity
    count--
    return row
  }

  function enabled(): boolean {
    return !disposed && call !== null && phoneName !== ''
  }

  function schedule(ms: number): void {
    if (!timer || disposed || scheduled !== null) return
    try {
      scheduled = timer.set(() => {
        scheduled = null
        void flush()
      }, ms)
    } catch {
      scheduled = null
    }
  }

  function delay(ms: number): Promise<void> {
    if (!timer || !(ms > 0)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      try {
        timer.set(resolve, ms)
      } catch {
        resolve()
      }
    })
  }

  /** 一次发送：形状不对（不是对象 / 没有数字 accepted,dropped）也算失败，交给退避重试。 */
  async function sendOnce(rows: ClientLogRow[]): Promise<Record<string, unknown>> {
    const payload = { rows: rows.map((r) => ({ level: r.level, event: r.event, fields: r.fields, ts: r.ts })) }
    const pendingCall = call ? call(phoneName, payload) : Promise.reject(new Error('no-channel'))
    if (!(sendTimeoutMs > 0) || !timer) return await pendingCall
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let done = false
      let handle: unknown = null
      try {
        handle = timer.set(() => {
          if (done) return
          done = true
          reject(new Error('log-append-timeout'))
        }, sendTimeoutMs)
      } catch {
        handle = null
      }
      pendingCall.then(
        (reply) => {
          if (done) return
          done = true
          if (handle !== null) {
            try {
              timer.clear(handle)
            } catch {
              /* 清不掉也无妨 */
            }
          }
          resolve(reply)
        },
        (error: unknown) => {
          if (done) return
          done = true
          if (handle !== null) {
            try {
              timer.clear(handle)
            } catch {
              /* 同上 */
            }
          }
          reject(error)
        },
      )
    })
  }

  /** 首发 + 退避重试；回执合法即算成功（accepted/dropped 都是数字）。 */
  async function sendWithRetry(rows: ClientLogRow[]): Promise<{ ok: boolean; reply: Record<string, unknown> | null }> {
    let attempt = 0
    for (;;) {
      try {
        const reply = await sendOnce(rows)
        if (reply && typeof reply === 'object' && typeof reply['accepted'] === 'number' && typeof reply['dropped'] === 'number') {
          return { ok: true, reply }
        }
      } catch {
        /* 传输失败：走退避 */
      }
      if (attempt >= maxRetries) return { ok: false, reply: null }
      const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)]
      attempt++
      await delay(typeof wait === 'number' && Number.isFinite(wait) ? wait : 0)
    }
  }

  async function flush(): Promise<void> {
    if (disposed || inFlight || count === 0) return
    if (!enabled()) {
      while (count > 0) noteDrop(shift(), 'no-channel')
      return
    }
    inFlight = true
    const batch: ClientLogRow[] = []
    while (batch.length < batchSize && count > 0) {
      const row = shift()
      if (!row) break
      batch.push(row)
    }
    try {
      const result = await sendWithRetry(batch)
      if (result.ok && result.reply) {
        const accepted = Number(result.reply['accepted'])
        const hostDropped = Number(result.reply['dropped'])
        sent += Number.isFinite(accepted) ? accepted : batch.length
        let lost = Number.isFinite(hostDropped) ? hostDropped : 0
        while (lost > 0) {
          noteDrop(null, 'host-refused')
          lost--
        }
      } else {
        for (const row of batch) noteDrop(row, 'send-failed')
      }
    } catch {
      for (const row of batch) noteDrop(row, 'send-failed')
    } finally {
      inFlight = false
    }
    if (disposed) return
    if (count >= batchSize) schedule(0)
    else if (count > 0) schedule(flushMs)
  }

  function onVisibilityChange(): void {
    try {
      const state = visibility?.visibilityState
      const hidden = visibility?.hidden === true || state === 'hidden'
      if (hidden) void flush()
    } catch {
      /* 可见性读坏了不影响别的 */
    }
  }

  if (visibility && typeof visibility.addEventListener === 'function') {
    try {
      visibility.addEventListener('visibilitychange', onVisibilityChange)
    } catch {
      /* 听不上就只剩定时冲刷 */
    }
  }

  function emit(level: string, event: string, fields: Record<string, unknown>): void {
    try {
      const eventName = typeof event === 'string' ? event : ''
      if (!eventName) return
      const row: ClientLogRow = {
        level: typeof level === 'string' && level ? level : 'info',
        event: eventName,
        fields: fields && typeof fields === 'object' ? fields : {},
        ts: now(),
      }
      if (disposed) {
        noteDrop(row, 'disposed')
        return
      }
      if (!enabled()) {
        noteDrop(row, 'no-channel')
        return
      }
      push(row)
      if (count >= batchSize) schedule(0)
      else schedule(flushMs)
    } catch {
      /* 报一行日志绝不能把面板搞崩 */
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (scheduled !== null && timer) {
      try {
        timer.clear(scheduled)
      } catch {
        /* 清不掉也无妨 */
      }
    }
    scheduled = null
    while (count > 0) noteDrop(shift(), 'disposed')
    if (visibility && typeof visibility.removeEventListener === 'function') {
      try {
        visibility.removeEventListener('visibilitychange', onVisibilityChange)
      } catch {
        /* 同上 */
      }
    }
  }

  return {
    emit,
    flush,
    pending: () => count,
    dropped: () => dropped,
    sent: () => sent,
    enabled,
    dispose,
  }
}
