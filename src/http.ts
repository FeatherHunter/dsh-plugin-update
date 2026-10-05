// src/http.ts —— HTTP 万能插头传输（#35，承接 #30 七行冻结：单插件三电话 + 批量五电话统一传输）。
//
// 纯加法：新子路径 dsh-plugin-update/http，只加新文件 + 新出口 + 文档/日志，不碰
// src/config.ts 冻结项（电话名/入参回参/落盘/配方/事件基线/默认路径）与老 7 入口形状。
// 零 Node 专属能力（不读盘、不起进程）：宿主与浏览器闭包两边都跑得动；fetch 只在
// createHttpCall 被调用时经参数或 globalThis 现取，模块顶层不碰网络。
//
// 第一性：电话名是逻辑名、路径是部署名，helper 只做忠实转接 + 全透传，不定义域语义。
// POST body = 调用参数原样；queue/env（含开关）/session/rows/progress/diag 全透；
// diagnostic 原话丢弃；diag 只留 16 键（detail 脱敏 300 字封顶）；传输失败走抛异常通道。

import { DEFAULT_PREFIX, assertPrefix } from './config.js'
import { assertPollInterval } from './client.js'
import { DIAG_KEYS } from './diag.js'
import { sanitizeDetail } from './redaction.js'
import { mountUpdatePanel, type UpdatePanelContainer, type UpdatePanelController, type UpdatePanelOptions } from './panel.js'
import { mountUpdateEntry, type UpdateEntryController, type UpdateEntryOptions } from './entry.js'
import { mountUpdateBatchPanel, type BatchPanelContainer, type BatchPanelController, type BatchPanelOptions } from './panel-batch.js'

/** 传输失败码：永不进面板 14 稳定码分支，只走抛异常通道。 */
export const HTTP_TRANSPORT_FAILED = 'http-transport-failed'

/** 抓取超时默认：查 15s / 装 16min（#30 冻结，调用方可覆写 + AbortSignal 透入）。 */
export const DEFAULT_HTTP_CHECK_TIMEOUT_MS = 15_000
export const DEFAULT_HTTP_INSTALL_TIMEOUT_MS = 16 * 60_000
export const DEFAULT_HTTP_STATUS_TIMEOUT_MS = 15_000

/** 单插件三电话动作名（与 src/config.ts PHONE_ACTIONS 同字面，不另起字面）。 */
export const HTTP_PHONE_ACTIONS = ['updateStatus', 'updateCheck', 'updateInstall'] as const
export type HttpPhoneAction = (typeof HTTP_PHONE_ACTIONS)[number]

/** 批量五电话动作名（与 src/panel-batch.ts buildBatchPhoneNames 同字面，不另起字面；同一内核）。 */
export const HTTP_BATCH_ACTIONS = ['batchStatus', 'batchCheck', 'batchInstall', 'batchResume', 'batchCancel'] as const
export type HttpBatchAction = (typeof HTTP_BATCH_ACTIONS)[number]

/** 逐电话覆写表：键为全电话名（prefix.动作）或短动作名；未知键拒绝。 */
export type HttpRoutes = Record<string, string>

/** 抓取函数形状：与 globalThis.fetch 同形（测试给内存假件）。 */
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: unknown }) => Promise<unknown>

export interface HttpTimeouts {
  /** 查/状态超时毫秒（默认 15s）。 */
  checkMs?: number
  /** 装超时毫秒（默认 16min）。 */
  installMs?: number
  /** 状态超时毫秒（默认 15s，与查同值）。 */
  statusMs?: number
}

export interface CreateHttpCallOptions {
  /** 单插件电话前缀（与宿主侧一致；电话名从它算出，不写字面量）。 */
  prefix: string
  /** 批量电话前缀（独立于单插件前缀；给了即同时校验批量五电话键，同一内核）。 */
  batchPrefix?: string
  /** 网关根：默认路径 = 网关根 + 全电话名（首尾斜杠归一）。 */
  baseUrl: string
  /** 电话级覆写表（routes[全电话名] ?? routes[短动作] ?? 默认拼接）。 */
  routes?: HttpRoutes
  /** 抓取注入点（不传即 globalThis.fetch；测试给假件）。 */
  fetch?: HttpFetch
  /** 同上别名（与 fetch 二选一，fetch 优先）。 */
  fetchImpl?: HttpFetch
  /** 超时覆写：数字即全电话统一；对象即按电话分设。 */
  timeout?: number | HttpTimeouts
  /** 同上别名（与 timeout 二选一，timeout 优先）。 */
  timeoutMs?: number | HttpTimeouts
}
// ---------- 路径解析（纯函数，可单独看） ----------

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function stripRightSlash(value: string): string {
  return String(value ?? '').replace(/\/+$/, '')
}

function joinBase(baseUrl: string, rel: string): string {
  const b = stripRightSlash(baseUrl)
  let r = String(rel ?? "")
  if (!r) return b
  if (!r.startsWith('/')) r = '/' + r
  return b + r
}

function shortActionOf(phoneName: string): string {
  const name = String(phoneName ?? "")
  const at = name.lastIndexOf(".")
  return at >= 0 ? name.slice(at + 1) : name
}

function allowedRouteKeys(prefix: string, batchPrefix?: string): Set<string> {
  const out = new Set<string>()
  for (const a of HTTP_PHONE_ACTIONS) {
    out.add(a)
    out.add(prefix + "." + a)
  }
  if (batchPrefix) {
    for (const a of HTTP_BATCH_ACTIONS) {
      out.add(a)
      out.add(batchPrefix + "." + a)
    }
  }
  return out
}

/** 覆写表未知键拒绝（创建即抛， fail-fast）。 */
export function assertHttpRoutes(routes: HttpRoutes | undefined, prefix: string, batchPrefix?: string): void {
  if (!routes) return
  const allowed = allowedRouteKeys(prefix, batchPrefix)
  for (const key of Object.keys(routes)) {
    if (!allowed.has(key)) {
      throw new Error('[dsh-plugin-update] routes 未知键拒绝：' + JSON.stringify(key))
    }
    const value = (routes as Record<string, unknown>)[key]
    if (typeof value !== 'string' || !value) {
      throw new Error('[dsh-plugin-update] routes 值非法：' + JSON.stringify(key))
    }
  }
}

/** 电话名 → POST 路径（默认拼接 + 电话级覆写 + 缺键回落 + 斜杠归一）。 */
export function resolveHttpPath(options: { prefix: string; batchPrefix?: string; baseUrl: string; routes?: HttpRoutes }, phoneName: string): string {
  if (typeof phoneName !== 'string' || !phoneName) {
    throw new Error('[dsh-plugin-update] 电话名非法：须为非空字符串')
  }
  const routes = options.routes ?? {}
  assertHttpRoutes(routes, options.prefix, options.batchPrefix)
  const short = shortActionOf(phoneName)
  const hit = (routes as Record<string, string>)[phoneName] ?? (routes as Record<string, string>)[short]
  if (hit !== undefined) {
    if (isAbsoluteUrl(hit)) return hit
    return joinBase(options.baseUrl, hit)
  }
  return joinBase(options.baseUrl, phoneName)
}

// ---------- 传输失败与 diag 宽容读 ----------

/** 传输失败：断网/非 2xx/JSON 非法/超时，永不进稳定码分支。 */
export function httpTransportFailed(reason: string, detail?: unknown): Error & { code: string; detail: string } {
  const clean = sanitizeDetail(String(detail ?? reason ?? ""))
  const err = new Error("[dsh-plugin-update] http-transport-failed: " + reason) as Error & { code: string; detail: string }
  err.code = HTTP_TRANSPORT_FAILED
  err.detail = clean
  return err
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** diag 宽容读：只留 16 键（DIAG_KEYS），detail 脱敏；diagnostic 原话丢弃。 */
export function pickHttpDiag(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, unknown> = {}
  let kept = 0
  for (const key of DIAG_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'string' || typeof value === 'number') {
      out[key] = key === "detail" ? sanitizeDetail(String(value)) : value
      kept++
    }
  }
  return kept > 0 ? out : undefined
}

/** 回包整形：diagnostic 丢弃，diag 过滤，其余（queue/env/session/rows/progress/未知键）原样透传。
 *
 * 批量行内同理：rows[i].diagnostic 丢弃，rows[i].diag 只留 16 键且 detail 脱敏；
 * 行内 queue/manual/snapshot/phoneNames 等原样透传（排队/续跑语义不裁剪）。 */
export function shapeHttpReply(parsed: unknown): Record<string, unknown> {
  if (!isRecord(parsed)) {
    throw httpTransportFailed("回包形状非法", String(parsed).slice(0, 120))
  }
  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) }
  if ("diagnostic" in out) delete out["diagnostic"]
  if ("diag" in out) {
    const kept = pickHttpDiag(out["diag"])
    if (kept) out["diag"] = kept
    else delete out["diag"]
  }
  if (Array.isArray(out["rows"])) {
    out["rows"] = (out["rows"] as unknown[]).map((row) => {
      if (!isRecord(row)) return row
      const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) }
      if ("diagnostic" in copy) delete copy["diagnostic"]
      if ("diag" in copy) {
        const kept = pickHttpDiag(copy["diag"])
        if (kept) copy["diag"] = kept
        else delete copy["diag"]
      }
      return copy
    })
  }
  return out
}

function timeoutForPhone(phoneName: string, timeout: number | HttpTimeouts | undefined): number {
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) return timeout
  const t = (timeout ?? {}) as HttpTimeouts
  if (phoneName.endsWith(".updateInstall") || phoneName.endsWith(".batchInstall")) {
    if (typeof t.installMs === "number" && Number.isFinite(t.installMs) && t.installMs > 0) return t.installMs
    return DEFAULT_HTTP_INSTALL_TIMEOUT_MS
  }
  if (phoneName.endsWith(".updateCheck") || phoneName.endsWith(".batchCheck")) {
    if (typeof t.checkMs === "number" && Number.isFinite(t.checkMs) && t.checkMs > 0) return t.checkMs
    return DEFAULT_HTTP_CHECK_TIMEOUT_MS
  }
  if (typeof t.statusMs === "number" && Number.isFinite(t.statusMs) && t.statusMs > 0) return t.statusMs
  if (typeof t.checkMs === "number" && Number.isFinite(t.checkMs) && t.checkMs > 0) return t.checkMs
  return DEFAULT_HTTP_STATUS_TIMEOUT_MS
}

function resolveFetchImpl(options: CreateHttpCallOptions): HttpFetch {
  const impl = options.fetch ?? options.fetchImpl ?? (globalThis as unknown as { fetch?: HttpFetch }).fetch
  if (typeof impl !== "function") {
    throw new Error('[dsh-plugin-update] HTTP 传输缺少抓取函数：请传 fetch 或在有 globalThis.fetch 的环境运行')
  }
  return impl as HttpFetch
}

// ---------- 传输工厂（与面板约定的通话函数同形状） ----------

/** 建 HTTP 通话函数：(phoneName, args) => Promise<reply>，回包全透传，失败抛异常。 */
export function createHttpCall(options: CreateHttpCallOptions): (phoneName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  if (!options || typeof options !== "object") {
    throw new Error('[dsh-plugin-update] 建 HTTP 传输缺少配置：前缀 prefix 与网关根 baseUrl 必填')
  }
  const prefix = options.prefix
  if (typeof prefix !== "string" || !prefix) {
    throw new Error('[dsh-plugin-update] 电话名前缀 prefix 非法：须为非空字符串')
  }
  if (prefix.includes(".") || prefix.includes("/") || prefix.includes("\\") || /\s/.test(prefix)) {
    throw new Error('[dsh-plugin-update] 电话名前缀 prefix 非法：不得含有点、路径分隔符或空白')
  }
  const baseUrl = options.baseUrl
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error('[dsh-plugin-update] 网关根 baseUrl 必填：须为非空字符串')
  }
  const routes = options.routes ?? {}
  assertHttpRoutes(routes, prefix, options.batchPrefix)
  const fetchImpl = resolveFetchImpl(options)
  const timeout = options.timeout ?? options.timeoutMs

  return async function httpCall(phoneName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof phoneName !== "string" || !phoneName) {
      throw new Error('[dsh-plugin-update] 电话名非法：须为非空字符串')
    }
    const url = resolveHttpPath({ prefix, batchPrefix: options.batchPrefix, baseUrl, routes }, phoneName)
    const safeArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
    const timeoutMs = timeoutForPhone(phoneName, timeout as number | HttpTimeouts | undefined)
    const body = JSON.stringify(stripSignal(safeArgs))
    const AbortCtor = (globalThis as unknown as { AbortController?: new () => { abort(): void; signal: unknown } }).AbortController
    const controller = typeof AbortCtor === "function" ? new AbortCtor() : null
    const callerSignal = (safeArgs as Record<string, unknown>)["signal"] as { addEventListener?: unknown } | null | undefined
    const onCallerAbort = () => { try { controller?.abort() } catch {} }
    if (callerSignal && typeof callerSignal.addEventListener === "function") {
      try { (callerSignal.addEventListener as (t: string, fn: () => void, o?: object) => void).call(callerSignal, "abort", onCallerAbort, { once: true }) } catch {}
    }
    let res: unknown
    const fetchPromise = (fetchImpl as (url: string, init: Record<string, unknown>) => Promise<unknown>)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      ...(controller ? { signal: controller.signal } : {}),
    })
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    void fetchPromise.catch(() => {})
    try {
      res = await Promise.race([
        fetchPromise,
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            try { controller?.abort() } catch {}
            reject(httpTransportFailed("超时", "抓取超时（" + String(timeoutMs) + "ms）：" + phoneName))
          }, timeoutMs)
        }),
      ])
    } catch (e) {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (e && typeof e === "object" && (e as { code?: unknown }).code === HTTP_TRANSPORT_FAILED) throw e
      throw httpTransportFailed(isAbortError(e) ? "超时或取消" : "断网或抓取失败", e instanceof Error ? e.message : String(e))
    }
    if (timeoutTimer) clearTimeout(timeoutTimer)
    const ok = (res as { ok?: unknown }).ok === true
    if (!ok) {
      const status = (res as { status?: unknown }).status
      const text = await readReplyText(res).catch(() => "")
      throw httpTransportFailed("非 2xx（" + String(status ?? "unknown") + "）", "HTTP " + String(status ?? "?") + ": " + String(text).slice(0, 120))
    }
    const text = await readReplyText(res)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw httpTransportFailed("JSON 非法", String(text).slice(0, 120))
    }
    return shapeHttpReply(parsed)
  }
}

function stripSignal(args: Record<string, unknown>): Record<string, unknown> {
  if (!("signal" in args)) return args
  const out: Record<string, unknown> = { ...args }
  delete out["signal"]
  return out
}

function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown }).name
  return name === "AbortError" || name === "TimeoutError"
}

async function readReplyText(res: unknown): Promise<string> {
  const textFn = (res as { text?: unknown }).text
  if (typeof textFn === "function") return String(await (textFn as () => Promise<unknown>).call(res))
  const jsonFn = (res as { json?: unknown }).json
  if (typeof jsonFn === "function") return JSON.stringify(await (jsonFn as () => Promise<unknown>).call(res))
  throw httpTransportFailed("回包形状非法", "抓取回包既无 text() 也无 json()")
}

// ---------- 薄封装：面板/入口直挂（注入既有内核，不另写界面） ----------

export interface UpdatePanelHttpOptions extends Omit<UpdatePanelOptions, "call" | "prefix"> {
  /** 单插件电话前缀（与宿主侧一致）。 */
  prefix?: string
  /** 网关根（必填）。 */
  baseUrl: string
  /** 电话级覆写表（可选）。 */
  routes?: HttpRoutes
  /** 抓取注入点（可选）。 */
  fetch?: HttpFetch
  fetchImpl?: HttpFetch
  /** 超时覆写（可选）。 */
  timeout?: number | HttpTimeouts
  timeoutMs?: number | HttpTimeouts
}

/** 面板整组件 HTTP 直挂：只传三样即跑，内核复用 mountUpdatePanel。 */
export function mountUpdatePanelHttp(container: UpdatePanelContainer, options: UpdatePanelHttpOptions): UpdatePanelController {
  if (!options || typeof options !== "object") {
    throw new Error('[dsh-plugin-update] 挂 HTTP 面板缺少配置：插件标识 pluginId 与网关根 baseUrl 必填')
  }
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const call = createHttpCall({ prefix, baseUrl: options.baseUrl, routes: options.routes, fetch: options.fetch, fetchImpl: options.fetchImpl, timeout: options.timeout, timeoutMs: options.timeoutMs })
  const { baseUrl: _b, routes: _r, fetch: _f, fetchImpl: _fi, timeout: _t, timeoutMs: _tm, prefix: _p, ...panelRest } = options as unknown as Record<string, unknown>
  return mountUpdatePanel(container, { ...(panelRest as object), pluginId: options.pluginId, prefix, call } as UpdatePanelOptions)
}

export interface UpdateEntryHttpOptions extends Omit<UpdateEntryOptions, "call" | "prefix"> {
  /** 单插件电话前缀（与宿主侧一致）。 */
  prefix?: string
  /** 网关根（必填）。 */
  baseUrl: string
  /** 电话级覆写表（可选）。 */
  routes?: HttpRoutes
  /** 抓取注入点（可选）。 */
  fetch?: HttpFetch
  fetchImpl?: HttpFetch
  /** 超时覆写（可选）。 */
  timeout?: number | HttpTimeouts
  timeoutMs?: number | HttpTimeouts
}

/** 入口件 HTTP 直挂：内部源码级禁安装电话，内核复用 mountUpdateEntry。 */
export function mountUpdateEntryHttp(container: UpdatePanelContainer, options: UpdateEntryHttpOptions): UpdateEntryController {
  if (!options || typeof options !== "object") {
    throw new Error('[dsh-plugin-update] 挂 HTTP 入口件缺少配置：插件标识 pluginId 与网关根 baseUrl 必填')
  }
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const rawCall = createHttpCall({ prefix, baseUrl: options.baseUrl, routes: options.routes, fetch: options.fetch, fetchImpl: options.fetchImpl, timeout: options.timeout, timeoutMs: options.timeoutMs })
  const guarded = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (shortActionOf(name) === "updateInstall") {
      throw new Error('[dsh-plugin-update] 入口件只允许只读电话，updateInstall 禁止（源码级）')
    }
    return rawCall(name, args)
  }
  const { baseUrl: _b, routes: _r, fetch: _f, fetchImpl: _fi, timeout: _t, timeoutMs: _tm, prefix: _p, ...entryRest } = options as unknown as Record<string, unknown>
  return mountUpdateEntry(container, { ...(entryRest as object), pluginId: options.pluginId, prefix, call: guarded } as UpdateEntryOptions)
}

// ---------- 薄封装：批量面板直挂（同一内核，不另起映射） ----------

export interface UpdateBatchPanelHttpOptions extends Omit<BatchPanelOptions, "call" | "prefix"> {
  /** 批量电话前缀（与宿主侧一致；五电话名从它算出，不写字面量）。 */
  batchPrefix: string
  /** 单插件电话前缀（可选；给了即同一内核同时认单三电话，便于同网关共用一张 routes 表）。 */
  prefix?: string
  /** 网关根（必填）。 */
  baseUrl: string
  /** 电话级覆写表（可选；键为全电话名或短动作名，未知键拒绝）。 */
  routes?: HttpRoutes
  /** 抓取注入点（可选）。 */
  fetch?: HttpFetch
  fetchImpl?: HttpFetch
  /** 超时覆写（可选；batchInstall 走装时限 16min，其余走查/状态 15s）。 */
  timeout?: number | HttpTimeouts
  timeoutMs?: number | HttpTimeouts
}

/** 批量面板 HTTP 直挂：只传批量前缀加网关根即跑，内核复用 mountUpdateBatchPanel。
 *
 * 取消整批走 batchCancel 电话而不走中止等待（语义不混淆）；卸载只停轮询，宿主侧照跑。 */
export function mountUpdateBatchPanelHttp(container: BatchPanelContainer, options: UpdateBatchPanelHttpOptions): BatchPanelController {
  if (!options || typeof options !== "object") {
    throw new Error('[dsh-plugin-update] 挂 HTTP 批量面板缺少配置：批量前缀 batchPrefix 与网关根 baseUrl 必填')
  }
  const batchPrefix = assertPrefix((options as { batchPrefix?: unknown }).batchPrefix, '批量电话前缀 batchPrefix')
  const kernelPrefix = typeof options.prefix === "string" && options.prefix ? assertPrefix(options.prefix, '电话名前缀 prefix') : batchPrefix
  const call = createHttpCall({ prefix: kernelPrefix, batchPrefix, baseUrl: options.baseUrl, routes: options.routes, fetch: options.fetch, fetchImpl: options.fetchImpl, timeout: options.timeout, timeoutMs: options.timeoutMs })
  const { baseUrl: _b, routes: _r, fetch: _f, fetchImpl: _fi, timeout: _t, timeoutMs: _tm, prefix: _p, batchPrefix: _bp, ...batchRest } = options as unknown as Record<string, unknown>
  return mountUpdateBatchPanel(container, { ...(batchRest as object), prefix: batchPrefix, call } as unknown as BatchPanelOptions)
}

// poll 口径复用转出口（与直调同文案同步抛；薄封装经既有内核已守，此处仅便调用方显式校验）。
export { assertPollInterval }

