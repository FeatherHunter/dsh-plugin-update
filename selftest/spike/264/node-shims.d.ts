/**
 * selftest/spike/264/node-shims.d.ts —— spike 脚本的最小 Node/浏览器全局形状。
 *
 * 为什么不用 @types/node：本仓库只把 typescript 当开发依赖，不引 @types/node（与
 * src/shared/node-ambient.d.ts 同一取舍）。spike 是证据采集脚本、不发布，因此这里用
 * 宽形状（any）换取「脚本能跑、tsc 不报错」，真正的行为由真机运行验证。
 */
declare module 'node:*'

declare const console: any
declare const process: any
declare const Buffer: any
declare const fetch: any
declare const AbortSignal: any
declare const WebSocket: any
declare const URL: any
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any
declare function clearTimeout(timer?: any): void
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any
declare function clearInterval(timer?: any): void
