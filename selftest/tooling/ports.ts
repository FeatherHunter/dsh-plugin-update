/**
 * selftest/tooling/ports.ts —— 端口探测（真机 harness 与本地 registry 都用它选空闲端口）。
 *
 * 选端口策略：绑定 127.0.0.1:0 让系统给一个空闲端口，再立刻释放；随后由真正的服务去绑。
 * 只用于本机测试，不与外部服务协商；服务起不来时由启动后的探活给出结论。
 */
import { createServer } from 'node:net'

interface ServerLike {
  once(event: string, listener: (...args: any[]) => void): void
  listen(port: number, host: string, callback?: () => void): void
  close(callback?: () => void): void
  address(): { port: number } | null
}

/** 选一个当前空闲的本地端口。 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer() as unknown as ServerLike
    server.once('error', (error: unknown) => reject(error))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address.port === 'number' ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('[tooling] 未能分配空闲端口'))
      })
    })
  })
}

/** 指定端口现在是否可用（能绑上就是空）。 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer() as unknown as ServerLike
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

/** 等端口释放（清理证据：进程关掉后端口必须真的回来）。 */
export async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true
    await new Promise((resolve) => setTimeout(() => resolve(undefined), 150))
  }
  return isPortFree(port)
}
