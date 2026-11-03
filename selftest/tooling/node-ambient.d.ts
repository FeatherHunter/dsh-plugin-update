/**
 * selftest/tooling/node-ambient.d.ts —— 真机工具层（selftest/fixtures + selftest/real-machine）用到的
 * Node 内建能力最小形状。规则与 src/shared/node-ambient.d.ts 同口径：不引入 @types/node 依赖。
 *
 * 这是「另一份」声明而不是复用 src/shared 的那份，原因：工具层要跑进程、开端口、算哈希、写二进制截图，
 * 用到的 Node 面比产品大；而产品那份是产品契约的一部分，不该为了让测试跑起来去撑大它。
 * 只用一份：本目录被 hermetic 的 selftest/tsconfig.json exclude 掉，所以两份声明不会在同一编译里相见。
 */

declare const console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface ImportMeta {
  url: string
}

declare module 'node:fs' {
  export interface Dirent {
    name: string
    isFile(): boolean
    isDirectory(): boolean
  }
  export interface Stats {
    size: number
    mtimeMs: number
    ctimeMs: number
    birthtimeMs: number
    isFile(): boolean
    isDirectory(): boolean
  }
  export function existsSync(path: string): boolean
  export function readFileSync(path: string, encoding: string): string
  export function readFileSync(path: string): Uint8Array
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { encoding?: string }): void
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  export function readdirSync(path: string): string[]
  export function mkdtempSync(prefix: string): string
  export function statSync(path: string): Stats
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function copyFileSync(from: string, to: string): void
  export function createWriteStream(path: string): { write(chunk: string): void; end(): void }
}

declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array>
  export function readFile(path: string, encoding: string): Promise<string>
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function readdir(path: string, options: { withFileTypes: true }): Promise<import('node:fs').Dirent[]>
  export function readdir(path: string): Promise<string[]>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  export function cp(from: string, to: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  export function stat(path: string): Promise<import('node:fs').Stats>
  export function lstat(path: string): Promise<import('node:fs').Stats>
  export function realpath(path: string): Promise<string>
  export function symlink(target: string, path: string, type?: 'dir' | 'file' | 'junction'): Promise<void>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function unlink(path: string): Promise<void>
  export function access(path: string): Promise<void>
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(path: string): string
  export function basename(path: string, suffix?: string): string
  export function relative(from: string, to: string): string
  export function extname(path: string): string
  export function isAbsolute(path: string): boolean
  export const sep: string
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
  export function cpus(): { model: string }[]
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: string): string }
  }
  export function randomUUID(): string
}

/** 可复用 UI driver（base-verify/web-ui.ts）按目录加载 playwright：只读装置，不进仓依赖。 */
declare module 'node:module' {
  export function createRequire(filename: string | URL): (specifier: string) => unknown
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
  export function pathToFileURL(path: string): { href: string }
}

declare module 'node:http' {
  export type Headers = Record<string, string | string[] | undefined>
  export interface IncomingMessage {
    statusCode?: number
    method?: string
    url?: string
    headers: Headers
    headersSent?: boolean
    on(event: string, listener: (...args: any[]) => void): void
    pipe<T>(destination: T): T
  }
  export interface ServerResponse {
    statusCode: number
    headersSent: boolean
    writeHead(statusCode: number, headers?: Headers): void
    setHeader(name: string, value: string): void
    end(data?: string): void
    on(event: string, listener: (...args: any[]) => void): void
  }
  export interface Server {
    on(event: string, listener: (...args: any[]) => void): void
    once(event: string, listener: (...args: any[]) => void): void
    listen(port: number, host: string, callback?: () => void): void
    close(callback?: () => void): void
    address(): { port: number } | null
  }
  export interface ClientRequest {
    on(event: string, listener: (...args: any[]) => void): void
    write(data: string): void
    end(): void
  }
  export function createServer(handler?: (incoming: IncomingMessage, outgoing: ServerResponse) => void): Server
  export function request(
    url: string,
    options: { method?: string; headers?: Headers },
    callback: (res: IncomingMessage) => void
  ): ClientRequest
  export function request(
    options: { host?: string; port?: number; method?: string; path?: string; headers?: Headers },
    callback: (res: IncomingMessage) => void
  ): ClientRequest
}

declare module 'node:https' {
  /** 仅声明缺口：TLS 前置（fixtures/release/tls-registry-front.ts）用它终止 TLS。 */
  export interface ServerOptions {
    cert: Uint8Array | string
    key: Uint8Array | string
  }
  export function createServer(
    options: ServerOptions,
    handler: (incoming: import('node:http').IncomingMessage, outgoing: import('node:http').ServerResponse) => void
  ): import('node:http').Server
}

declare module 'node:net' {
  export interface Socket {
    on(event: string, listener: (...args: any[]) => void): void
    destroy(): void
  }
  export function createServer(): {
    once(event: string, listener: (...args: any[]) => void): void
    listen(port: number, host: string, callback?: () => void): void
    close(callback?: () => void): void
    address(): { port: number } | null
  }
  export function connect(options: { port: number; host: string }): {
    once(event: string, listener: (...args: any[]) => void): void
    destroy(): void
  }
}

declare module 'node:child_process' {
  export interface ChildProcess {
    readonly pid?: number
    readonly stdout: { on(event: 'data', listener: (chunk: Uint8Array) => void): void } | null
    readonly stderr: { on(event: 'data', listener: (chunk: Uint8Array) => void): void } | null
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
    on(event: 'error', listener: (error: Error) => void): void
    kill(signal?: string): boolean
  }
  export interface SpawnOptions {
    cwd?: string
    env?: Record<string, string | undefined>
    shell?: boolean
    windowsHide?: boolean
    timeout?: number
    stdio?: 'ignore' | 'pipe' | 'inherit' | Array<'ignore' | 'pipe' | 'inherit'>
  }
  export function spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: SpawnOptions
  ): { status: number | null; signal: string | null; stdout: string; stderr: string; error?: Error }
}

declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  execPath: string
  pid: number
  platform: string
  version: string
  versions: { node: string }
  cwd(): string
  exit(code?: number): never
  kill(pid: number, signal?: number | string): boolean
  once(event: 'exit', listener: () => void): void
  on(event: 'exit', listener: () => void): void
}

declare function setTimeout(callback: () => void, ms: number): unknown
declare function clearTimeout(handle: unknown): void
declare function setInterval(callback: () => void, ms: number): unknown
declare function clearInterval(handle: unknown): void

declare class URL {
  constructor(url: string, base?: string)
  readonly href: string
  readonly protocol: string
  readonly host: string
  readonly hostname: string
  readonly port: string
  readonly pathname: string
  readonly search: string
  readonly origin: string
  readonly searchParams: { get(name: string): string | null }
}

declare const fetch: (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: 'follow' | 'manual' | 'error' }
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<any>
}>

declare class WebSocket {
  constructor(url: string, protocols?: string | string[])
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

declare const Buffer: {
  from(input: string, encoding: string): Uint8Array & { toString(encoding: string): string }
  from(input: Uint8Array): Uint8Array & { toString(encoding: string): string }
  concat(chunks: Uint8Array[]): Uint8Array & { toString(encoding: string): string }
  isBuffer(value: unknown): boolean
}

declare function btoa(data: string): string
declare function atob(data: string): string
