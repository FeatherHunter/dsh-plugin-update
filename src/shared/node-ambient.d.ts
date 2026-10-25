/**
 * src/shared/node-ambient.d.ts —— 本包触碰的 Node 内建能力最小形状。
 *
 * 为什么不用 @types/node：本包只把 `dsh-log` 当运行期依赖（ADR-0005），不为类型再带一份依赖 ——
 * 加了 @types/node 就等于让每个消费者跟着装它。本文件只声明本包实际用到的几个函数形状，
 * 调用处照旧传真值，类型检查只认这里写的形状。新增 Node 能力先补这里，再在实现里用。
 */

declare module 'node:async_hooks' {
  // 宿主侧链上下文（src/log/trace.ts）：只用到「在一段调用里带上一个环境值」这一件事。
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined
    run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R
  }
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: string): string }
  }
  export function randomUUID(): string
}

declare module 'node:fs' {
  // 只用于「随包事件清单」的同步读取：字段白名单的判据必须当场就有（异步读会让同一份代码
  // 在清单没加载完时放行、加载完后拒收，行为不确定）。只读一个小 JSON，读一次进程内缓存。
  // 另用于进程退出钩子的同步归还租约（host/hub/lease-store.ts 的 releaseHubLeaseSync）：
  // exit 事件里只能跑同步代码，读回租约 + 删掉自己的那一代，下一次启动即可直接接管。
  export function readFileSync(path: string, encoding: string): string
  export function unlinkSync(path: string): void
}

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>
  /** 中枢方案目录列举（host/hub/plan-store.ts）：只读文件名，不递归。 */
  export function readdir(path: string): Promise<string[]>
  export function open(
    path: string,
    flags: string,
    mode?: number
  ): Promise<{ writeFile(data: string): Promise<void>; close(): Promise<void> }>
  export function readFile(path: string, encoding?: string): Promise<string>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function realpath(path: string): Promise<string>
  // 锁原子建（#181）：硬链接在目标已存在时回 EEXIST，是「要么没有、要么完整」的锁位判据。
  export function link(oldPath: string, newPath: string): Promise<void>
  // mtimeMs：锁废弃判据（时间 + 可解析性）里的「时间」一列。
  export function stat(path: string): Promise<{ size: number; isFile(): boolean; mtimeMs: number }>
  export function unlink(path: string): Promise<void>
  export function writeFile(path: string, data: string, options?: { mode?: number; flag?: string }): Promise<void>
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:module' {
  export function createRequire(filename: string): { resolve(spec: string): string }
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(path: string): string
  export function basename(path: string): string
  export function relative(from: string, to: string): string
  export function isAbsolute(path: string): boolean
  export const sep: string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}

declare module 'node:zlib' {
  export function gunzipSync(data: Uint8Array): Uint8Array
}

// 模块地址（读取器与宿主入口用 import.meta.url 反查已装位置，只读地址，不碰模块状态）。
interface ImportMeta {
  url: string
}

// 计时器回退只用运行环境自带的全局函数，不引入任何 Node 或浏览器专属类型（与 dsh-log 同口径）。
declare function setTimeout(fn: () => void, ms: number): unknown
declare function clearTimeout(handle: unknown): void

// 二进制长度计算（使用范围名合法性判定用，只读字节长度，不碰缓冲内容）。
declare const Buffer: {
  byteLength(input: string, encoding?: string): number
  from(input: Uint8Array | ArrayBuffer | string, encoding?: string): Uint8Array & {
    slice(start?: number, end?: number): Uint8Array & { toString(encoding?: string): string }
    toString(encoding?: string): string
  }
}

// 宿主进程全局（本包只读环境变量、运行时路径、进程号、Node 版本号；唯一的进程级挂钩是下面
// once('exit') 的只读退出通知——它不写进程状态，只在退出前同步归还本代租约）。
// kill(pid, 0) 是租约「原驾驶者还活着吗」的探测（host/hub/registry.ts）：只发零号信号，不真杀。
declare const process: {
  env: Record<string, string | undefined>
  execPath: string
  execArgv: string[]
  argv: string[]
  pid: number
  versions: { node: string }
  kill(pid: number, signal?: number | string): boolean
  // 中枢退出钩子（#253）：宿主关停时同步停表并归还本代租约；只认 exit 这一个事件。
  once(event: 'exit', listener: () => void): void
}
