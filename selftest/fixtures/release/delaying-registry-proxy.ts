/**
 * selftest/fixtures/release/delaying-registry-proxy.ts —— 出口三超时格的故障注入：挂在 verdaccio 前面的延迟代理。
 *
 * 为什么需要它：出口三的 installTimeoutMs 是「宿主给 CLI 子进程的预算」，要真触发超时，
 * 安装必须真的比预算慢。最可控的办法是让 pnpm 的 registry 请求被挂住：
 *   - 只有 pnpm 的请求（User-Agent 含 pnpm）被延迟，产品自己的 check（node fetch）不受影响；
 *   - 代理把请求原样转给本地 verdaccio，请求日志进 raw 证据；
 *   - stop 时销毁所有挂起的 socket，不留孤儿连接。
 *
 * 判据（T3 超时格）：update.install.exec route=cli-process ok=false、durationMs 落在
 * [installTimeoutMs, installTimeoutMs+3000) 宽限内；update.install.fail reason=timeout。
 */
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { findFreePort } from '../../tooling/ports.ts'
import { sleep } from '../../tooling/process.ts'

/** 一条经过代理的请求（证据用）。 */
export interface ProxiedRegistryRequest {
  readonly method: string
  readonly url: string
  readonly userAgent: string
  readonly delayed: boolean
}

/** 起一个延迟代理的入参。 */
export interface DelayingRegistryProxyOptions {
  /** 上游 registry（本地 verdaccio）的 baseUrl，如 http://127.0.0.1:59423。 */
  readonly upstreamBaseUrl: string
  /** 命中请求的延迟毫秒数（要明显大于被测 installTimeoutMs）。 */
  readonly delayMs?: number
  /** 命中条件；缺省只延迟 pnpm 的请求。 */
  readonly match?: 'pnpm-user-agent' | 'all'
  /** 指定端口（缺省找空闲端口）。 */
  readonly port?: number
}

/** 一个已启动的延迟代理。 */
export interface DelayingRegistryProxy {
  readonly baseUrl: string
  readonly port: number
  requests(): readonly ProxiedRegistryRequest[]
  delayedCount(): number
  stop(): Promise<void>
}

/** 起延迟代理：监听本机端口，按条件挂起 pnpm 请求后转发给上游。 */
export async function startDelayingRegistryProxy(options: DelayingRegistryProxyOptions): Promise<DelayingRegistryProxy> {
  const upstream = new URL(options.upstreamBaseUrl)
  const upstreamPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80))
  const delayMs = options.delayMs ?? 15000
  const match = options.match ?? 'pnpm-user-agent'
  const port = options.port ?? (await findFreePort())
  const requests: ProxiedRegistryRequest[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((incoming, outgoing) => {
    const userAgent = String(incoming.headers['user-agent'] || '')
    const delayed = match === 'all' || userAgent.toLowerCase().indexOf('pnpm') >= 0
    requests.push({ method: incoming.method || 'GET', url: incoming.url || '/', userAgent, delayed })
    const forward = () => {
      const upstreamRequest = httpRequest(
        {
          host: upstream.hostname,
          port: upstreamPort,
          method: incoming.method,
          path: incoming.url,
          // 必须保留客户端原本的 Host（代理自己的 host:port），不能改成上游 host：verdaccio 用 Host
          // 头拼 dist.tarball 的绝对地址，产品会校验 tarball.origin 与 registry origin 一致；改成上游
          // host 会让「registry=代理、tarball=上游」对不上，check 直接 invalid-release(shape)。
          headers: { ...incoming.headers },
        },
        (upstreamResponse) => {
          outgoing.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
          upstreamResponse.pipe(outgoing)
        },
      )
      upstreamRequest.on('error', (error: Error) => {
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        outgoing.end('代理上游不可达：' + error.message)
      })
      incoming.pipe(upstreamRequest)
    }
    if (delayed) {
      sleep(delayMs).then(forward, () => forward())
      return
    }
    forward()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    baseUrl: 'http://127.0.0.1:' + String(port),
    port,
    requests: () => requests,
    delayedCount: () => requests.filter((item) => item.delayed).length,
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
