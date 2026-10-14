/**
 * src/log/own-version.ts —— 本包自己的版本号（写进启动头 `host.start` 的那一格）。
 *
 * 为什么需要它：dsh-log 0.3.3 起启动头可以带 `pluginVersion`（「这个目录是哪一版写的」），
 * 而 **0.3.4 起这个头幂等** —— 同一个实例只写一行，`writeStartupHeader` 第二次调用直接返回
 * 首写结果。也就是说版本必须在**建库那一刻**就给，接线跑起来之后再去补是补不上的。
 * 所以登记表在建库配置里默认填本包版本，而不是等调用方想起来传。
 *
 * 事实源是本包自己的 `package.json`（发布时随包带上：`files` 白名单里有 `dist` 与隐含的
 * `package.json`）。路径算式与 `manifest.ts` 同一套：`dist/log/<file>.js` 往上三层即包根，
 * 发布后就是 `node_modules/dsh-plugin-update/`。
 *
 * 读不到（打包漏带、只读介质、JSON 坏）只影响启动头里那一格：回 null，绝不外抛。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根：`dist/log/<file>.js` 往上三层（发布后就是 `node_modules/dsh-plugin-update/`）。 */
export function packageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))))
}

let cached: string | null = null
let loaded = false

/**
 * 本包版本号（`package.json` 的 `version`）；读不到或形状不对回 null。
 * **同步**是有意的：建库配置要当场填好，异步读会让「这一版是谁写的」随微任务时序漂移。
 * 进程内缓存一次，失败也缓存（不反复读盘）。
 */
export function ownPackageVersion(): string | null {
  if (loaded) return cached
  loaded = true
  try {
    const text = readFileSync(join(packageRoot(), 'package.json'), 'utf8')
    const version = (JSON.parse(text) as { version?: unknown }).version
    const one = typeof version === 'string' ? version.trim() : ''
    cached = one === '' ? null : one
  } catch {
    cached = null
  }
  return cached
}

/** 测试用：清掉进程内缓存（换一份 package.json 再读一次的场合）。 */
export function __resetOwnPackageVersionForTests(): void {
  cached = null
  loaded = false
}
