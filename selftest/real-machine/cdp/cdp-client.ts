/**
 * selftest/real-machine/cdp/cdp-client.ts —— 零依赖 CDP 客户端（Node 内置 WebSocket + fetch）。
 *
 * 为什么裸 CDP：官方桌面是 Electron，页面目标在 --remote-debugging-port 后面；普通 DSH 宿主则是
 * 系统 Chrome headless 打开 dsh web 页面。两条通道共用同一套「连上 → evaluate 点击 → 截图」原语。
 *
 * 点击纪律（exploration 已证）：CDP 坐标点击在 headless / 桌面页面上不可靠，统一用
 * Runtime.evaluate 里的 element.click()，点击的是 DOM 事件而不是像素。
 */
import { sleep, waitFor } from '../../tooling/process.ts'

/** /json/list 里的一个调试目标。 */
export interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly url: string
  readonly title?: string
  readonly webSocketDebuggerUrl?: string
}

/** 列调试目标（HTTP，不经 CDP）。 */
export async function listDebugTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list')
  if (!response.ok) throw new Error('[cdp] /json/list 失败（HTTP ' + response.status + '）')
  return (await response.json()) as CdpTarget[]
}

/** 等一个页面目标出现（app 启动/宿主拉起都需要等）。 */
export async function waitForPageTarget(port: number, options: { timeoutMs?: number; urlIncludes?: string } = {}): Promise<CdpTarget> {
  return waitFor(
    'CDP 页面目标（端口 ' + port + '）',
    async () => {
      try {
        const targets = await listDebugTargets(port)
        const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
        if (options.urlIncludes) return pages.find((page) => page.url.indexOf(options.urlIncludes as string) >= 0) || null
        return pages[0] || null
      } catch (error) {
        return null
      }
    },
    { timeoutMs: options.timeoutMs || 120000, intervalMs: 400 },
  )
}

/** 页面里抓到的一条 console/异常/日志事件。 */
export interface PageEventRecord {
  readonly kind: 'console' | 'exception' | 'log'
  readonly level: string
  readonly text: string
  readonly at: string
}

/** CDP 连接（一次 run 一个页面）。 */
export class CdpClient {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>()
  private readonly events: PageEventRecord[] = []
  private sequence = 0
  private closed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.onmessage = (event: { data: string }) => this.onMessage(event.data)
    this.socket.onclose = () => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(new Error('[cdp] 连接已关闭，未完成的 ' + entry.method))
      this.pending.clear()
    }
  }

  /** 连上一个页面目标的 WebSocket 调试地址。 */
  static async connect(webSocketUrl: string, options: { timeoutMs?: number } = {}): Promise<CdpClient> {
    return waitFor('CDP WebSocket 连接', async () => {
      const socket = new WebSocket(webSocketUrl)
      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000)
        socket.onopen = () => {
          clearTimeout(timer)
          resolve(true)
        }
        socket.onerror = () => {
          clearTimeout(timer)
          resolve(false)
        }
      })
      if (!opened) {
        try {
          socket.close()
        } catch (error) {
          // 忽略：连接本来就失败
        }
        return null
      }
      return new CdpClient(socket)
    }, { timeoutMs: options.timeoutMs || 30000, intervalMs: 400 })
  }

  private onMessage(raw: string): void {
    let message: any
    try {
      message = JSON.parse(raw)
    } catch (error) {
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error('[cdp] ' + entry.method + ' 失败：' + JSON.stringify(message.error)))
      else entry.resolve(message.result)
      return
    }
    this.captureEvent(message)
  }

  private captureEvent(message: any): void {
    const at = new Date().toISOString()
    if (message.method === 'Runtime.consoleAPICalled') {
      const args = (message.params && message.params.args) || []
      const text = args.map((arg: any) => (arg && typeof arg.value !== 'undefined' ? String(arg.value) : arg && arg.description ? String(arg.description) : '')).join(' ')
      this.events.push({ kind: 'console', level: String((message.params && message.params.type) || 'log'), text, at })
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params && message.params.exceptionDetails
      const text = detail ? String(detail.text || '') + ' ' + String((detail.exception && detail.exception.description) || '') : ''
      this.events.push({ kind: 'exception', level: 'error', text, at })
      return
    }
    if (message.method === 'Log.entryAdded' && message.params && message.params.entry) {
      const entry = message.params.entry
      this.events.push({ kind: 'log', level: String(entry.level || 'info'), text: String(entry.text || ''), at })
    }
  }

  /**
   * 发一条 CDP 命令。
   *
   * 必须带超时：官方桌面的 Page 域偶发不回包（首启渲染中），没有超时会把整条 run 挂死。
   */
  send<T = any>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('[cdp] 连接已关闭：' + method))
    this.sequence += 1
    const id = this.sequence
    const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('[cdp] ' + method + ' 超时（' + timeoutMs + 'ms 没有回包）'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value: any) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        },
        method,
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 开页面事件收集（console/异常/日志；网络失败以 log 形式进）。 */
  async enableEventCollection(): Promise<void> {
    await this.send('Runtime.enable')
    await this.send('Log.enable')
  }

  /** 收集到的事件（返回副本）。 */
  collectedEvents(): PageEventRecord[] {
    return this.events.slice()
  }

  /** 在页面里求值（默认 awaitPromise + userGesture，等价于真实用户动作后的执行）。 */
  async evaluate<T = unknown>(expression: string, options: { awaitPromise?: boolean; userGesture?: boolean } = {}): Promise<T> {
    const result = await this.send<{ result: { value?: T; description?: string }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise === undefined ? true : options.awaitPromise,
      userGesture: options.userGesture === undefined ? true : options.userGesture,
    })
    if (result.exceptionDetails) throw new Error('[cdp] 页面求值异常：' + String(result.exceptionDetails.text))
    return result.result.value as T
  }

  /** 轮询等页面里的表达式为真；超时抛错。 */
  async waitForExpression(expression: string, options: { timeoutMs?: number; label?: string; intervalMs?: number } = {}): Promise<void> {
    await waitFor(
      options.label || ('页面条件：' + expression),
      async () => {
        try {
          const value = await this.evaluate<unknown>(expression)
          return value ? true : null
        } catch (error) {
          return null
        }
      },
      { timeoutMs: options.timeoutMs || 30000, intervalMs: options.intervalMs || 400 },
    )
  }

  /** 等选择器出现。 */
  async waitForSelector(selector: string, options: { timeoutMs?: number } = {}): Promise<void> {
    await this.waitForExpression('!!document.querySelector(' + JSON.stringify(selector) + ')', {
      timeoutMs: options.timeoutMs || 30000,
      label: '选择器出现：' + selector,
    })
  }

  /** 元素点击（DOM click，不做像素点击）。 */
  async clickSelector(selector: string, options: { timeoutMs?: number } = {}): Promise<void> {
    await this.waitForSelector(selector, options)
    await this.evaluate(
      '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.click(); return true })()',
    )
  }

  /** 元素滚动进视口（集成方入口件常在视口外；exploration 实测必须 scrollIntoView）。 */
  async scrollIntoView(selector: string): Promise<void> {
    await this.evaluate(
      '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.scrollIntoView({ block: "center" }); return true })()',
    )
  }

  /** 页面文本（人读断言用；不许拿文案当稳定选择器）。 */
  async pageText(): Promise<string> {
    return this.evaluate<string>('document.body ? document.body.innerText : ""')
  }

  /** 截图（整窗；可选 clip 局部）。返回 png 字节。 */
  async screenshot(options: { clip?: { x: number; y: number; width: number; height: number; scale?: number }; timeoutMs?: number } = {}): Promise<Uint8Array> {
    const params: Record<string, unknown> = { format: 'png', fromSurface: true }
    if (options.clip) params.clip = { ...options.clip, scale: options.clip.scale || 1 }
    try {
      const result = await this.send<{ data: string }>('Page.captureScreenshot', params, { timeoutMs: options.timeoutMs || 60000 })
      return Buffer.from(result.data, 'base64')
    } catch (error) {
      // 兜底：某些页面在 Page 域刚开/窗口刚显示时会丢弃第一张截图请求；重开 Page 域再试一次。
      await this.send('Page.enable', {}, { timeoutMs: 15000 }).catch(() => null)
      const retry = await this.send<{ data: string }>('Page.captureScreenshot', params, { timeoutMs: options.timeoutMs || 60000 })
      return Buffer.from(retry.data, 'base64')
    }
  }

  /** 关连接（幂等）。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.close()
    } catch (error) {
      // 已关闭
    }
  }
}

/** 小工具：等一小会儿再重试一次求值（页面重渲染的抖动用）。 */
export async function retryEvaluate<T>(client: CdpClient, expression: string, attempts = 5, delayMs = 300): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await client.evaluate<T>(expression)
    } catch (error) {
      await sleep(delayMs)
    }
  }
  return null
}
