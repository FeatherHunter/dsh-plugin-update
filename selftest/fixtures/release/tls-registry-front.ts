/**
 * selftest/fixtures/release/tls-registry-front.ts —— 以 HTTPS 暴露本地 verdaccio 的常驻前置（更新日志真机格需要）。
 *
 * 为什么需要它：产品取更新日志（src/core/changelog/io.ts:347-359）硬性要求
 *   dist.tarball 是 https、与 registry 同 origin、path 精确等于 /<name>/-/<name>-<ver>.tgz；
 * 本地 verdaccio 只监听 http。若产品配置的 registry 也是 http://，changelog 永远 fetch-failed，
 * K1 的 changelog 断言不可能绿。
 *
 * 做法：前置用自签证书（SAN=IP:127.0.0.1,DNS=localhost）终止 TLS，把请求原样转给 verdaccio，
 * 同时保留客户端原本的 Host（=前置自己）并补 x-forwarded-proto: https；@verdaccio/url 的
 * getPublicUrl 会按 Host + 该头拼 dist.tarball 的绝对地址，所以返回的 tarball 是
 * https://127.0.0.1:<frontPort>/<pkg>/-/<pkg>-<ver>.tgz，与 registry origin 一致，产品同源校验
 * 通过。同理，pnpm 装包也走这条 https 前置。
 *
 * 信任链：自签证书由本机 openssl 现场生成（不入库），宿主/CLI 子进程靠注入
 * NODE_EXTRA_CA_CERTS=<certPath> 信任它（Electron 的 RUN_AS_NODE 模式已实测生效）。
 *
 * 延迟：同一前置支持按请求挂起（默认只挂 pnpm 的 User-Agent），供「安装窗」试点逐代
 * 用 setDelay 开关；不延迟时安装立刻完成。
 */
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Socket } from 'node:net'

import type { ProxiedRegistryRequest } from './delaying-registry-proxy.ts'
import { ensureDir, sha256File } from '../../tooling/fs-utils.ts'
import { findFreePort } from '../../tooling/ports.ts'
import { sleep } from '../../tooling/process.ts'

/** 延迟配置；null 表示不延迟。 */
export interface TlsFrontDelay {
  readonly delayMs: number
  readonly match?: 'pnpm-user-agent' | 'all'
}

/** 起一个 TLS 前置的入参。 */
export interface TlsRegistryFrontOptions {
  /** 上游 registry（本地 verdaccio）的 baseUrl，如 http://127.0.0.1:59423。 */
  readonly upstreamBaseUrl: string
  /** 自签证书/私钥存放目录（run 私有；仓库外）。 */
  readonly certificateDir: string
  /** 指定监听端口（缺省找空闲端口）。 */
  readonly port?: number
}

/** 自签证书材料。 */
export interface SelfSignedCertificate {
  readonly certPath: string
  readonly keyPath: string
  readonly certSha256: string
}

/** 一个已启动的 TLS registry 前置。 */
export interface TlsRegistryFront {
  /** 产品/宿主配置的 registry origin（https://127.0.0.1:<port>）。 */
  readonly baseUrl: string
  readonly port: number
  /** CA 证书路径（子进程注入 NODE_EXTRA_CA_CERTS）。 */
  readonly certPath: string
  /** 证书 sha256（证据里记录，证明用的是哪份自签材料）。 */
  readonly certSha256: string
  requests(): readonly ProxiedRegistryRequest[]
  delayedCount(): number
  /** 切换延迟行为（起宿主前设、停宿主后清）。 */
  setDelay(delay: TlsFrontDelay | null): void
  stop(): Promise<void>
}

/** 候选 openssl：环境变量优先，其次 Git for Windows 自带，最后 PATH 里的 openssl。 */
function opensslCandidates(): string[] {
  const candidates: string[] = []
  const fromEnv = process.env['DSH_SELFTEST_OPENSSL']
  if (fromEnv) candidates.push(fromEnv)
  candidates.push('C:\\Program Files\\Git\\usr\\bin\\openssl.exe')
  candidates.push('C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe')
  candidates.push('openssl')
  return candidates
}

/** 生成自签证书（已有则复用）：SAN 必须含 IP:127.0.0.1，否则 hostname 校验失败。 */
export async function ensureSelfSignedCertificate(certificateDir: string): Promise<SelfSignedCertificate> {
  await ensureDir(certificateDir)
  const certPath = join(certificateDir, 'cert.pem')
  const keyPath = join(certificateDir, 'key.pem')
  if (!(existsSync(certPath) && existsSync(keyPath))) {
    const errors: string[] = []
    for (const candidate of opensslCandidates()) {
      if (candidate !== 'openssl' && !existsSync(candidate)) {
        errors.push(candidate + '：不存在')
        continue
      }
      const result = spawnSync(
        candidate,
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', keyPath,
          '-out', certPath,
          '-days', '3650',
          '-subj', '/CN=127.0.0.1',
          '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
        ],
        { windowsHide: true },
      )
      if (result.status === 0 && existsSync(certPath) && existsSync(keyPath)) {
        errors.length = 0
        break
      }
      errors.push(candidate + '：exit=' + String(result.status) + '；' + String(result.stderr || result.error || '').slice(-200))
    }
    if (!(existsSync(certPath) && existsSync(keyPath))) {
      throw new Error('[tls-registry-front] 生成自签证书失败（需要 openssl）；尝试过：' + errors.join(' / '))
    }
  }
  return { certPath, keyPath, certSha256: await sha256File(certPath) }
}

/** 起 TLS 前置：监听本机端口，转发到上游 http verdaccio，并按 setDelay 挂起命中请求。 */
export async function startTlsRegistryFront(options: TlsRegistryFrontOptions): Promise<TlsRegistryFront> {
  const upstream = new URL(options.upstreamBaseUrl)
  const upstreamPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80))
  if (upstream.protocol !== 'http:') throw new Error('[tls-registry-front] 上游必须是 http verdaccio：' + options.upstreamBaseUrl)
  const tls = await ensureSelfSignedCertificate(options.certificateDir)
  const certPem = readFileSync(tls.certPath)
  const keyPem = readFileSync(tls.keyPath)
  const port = options.port ?? (await findFreePort())
  const requests: ProxiedRegistryRequest[] = []
  const sockets = new Set<Socket>()
  let delay: TlsFrontDelay | null = null
  const server: Server = createServer({ cert: certPem, key: keyPem }, (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const userAgent = String(incoming.headers['user-agent'] || '')
    const delayed = delay !== null && (delay.match === 'all' || userAgent.toLowerCase().indexOf('pnpm') >= 0)
    requests.push({ method: incoming.method || 'GET', url: incoming.url || '/', userAgent, delayed })
    const forward = (): void => {
      // 保留客户端原本的 Host（=前置自己的 host:port），只补 x-forwarded-proto：
      // verdaccio 的 getPublicUrl 会用 Host + x-forwarded-proto 拼 dist.tarball 的绝对地址。
      const headers: Record<string, string | string[] | undefined> = { ...incoming.headers }
      headers['x-forwarded-proto'] = 'https'
      const upstreamRequest = httpRequest(
        { host: upstream.hostname, port: upstreamPort, method: incoming.method, path: incoming.url, headers },
        (upstreamResponse) => {
          outgoing.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
          upstreamResponse.pipe(outgoing)
        },
      )
      upstreamRequest.on('error', (error: Error) => {
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        outgoing.end('TLS 前置上游不可达：' + error.message)
      })
      incoming.pipe(upstreamRequest)
    }
    if (delayed) {
      sleep((delay as TlsFrontDelay).delayMs).then(forward, () => forward())
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
    baseUrl: 'https://127.0.0.1:' + String(port),
    port,
    certPath: tls.certPath,
    certSha256: tls.certSha256,
    requests: () => requests,
    delayedCount: () => requests.filter((item) => item.delayed).length,
    setDelay: (next) => {
      delay = next
    },
    stop: async () => {
      delay = null
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}