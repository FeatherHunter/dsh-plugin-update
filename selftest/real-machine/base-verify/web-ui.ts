/**
 * selftest/real-machine/base-verify/web-ui.ts —— base 场景用的真机 UI driver（Playwright，可选依赖）。
 *
 * 为什么需要它：base 的 PageHandle 只到「页面对象」这一层，而且没有 goto；直接用 page() 打开实例
 * 会在 origin root 停下，body 是 'dsh web authentication required; reopen the URL printed by dsh web.'。
 * 真 UI 必须用实例记录里的 tokenUrl 做一次带 token 的 goto（cookie 握手才成立）。本文件把这一步、
 * 等待/取文本、截图 + 六字段 sidecar 收成可复用原语，谁写 UI 场景都不必再踩一遍 auth 坑。
 *
 * 依赖口径：不把 playwright 放进 package.json。运行期按 DSH_VERIFY_PLAYWRIGHT 指向的已安装目录加载，
 * 找不到就返回结构化失败（场景据此判 blocked，不是产品失败）。
 */
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { ensureDir, writeJsonFile } from '../../tooling/fs-utils.ts'
import { formatError, sleep } from '../../tooling/process.ts'

const require = createRequire(import.meta.url)

/** base/实例页在未带 token 时会显式写这句；断言遇到它说明 goto 姿势错了。 */
export const AUTH_REQUIRED_MARKER = 'authentication required'

/** 截图 sidecar 的六个固定中文键（与 selftest/evidence 契约、scenario-run.ts 校验器一致）。 */
export const SHOT_SIDECAR_KEYS = ['看什么', '步骤', 'expected', 'actual', '判定', '备注'] as const

/** 一页截图旁注：这张图看什么、怎么走到这、预期、实际、判定、备注。 */
export interface ShotMeta {
  readonly what: string
  readonly steps: string
  readonly expected: string
  readonly actual: string
  readonly verdict: 'pass' | 'fail' | 'skip' | 'blocked'
  readonly note?: string | null
}

/** Playwright 页面用到的最小面（不引 @types/playwright）。 */
export interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  url(): string
  title(): Promise<string>
  innerText(selector: string): Promise<string>
  evaluate<T = unknown>(script: string, arg?: unknown): Promise<T>
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Uint8Array>
  close(): Promise<void>
}

/** Playwright 浏览器上下文的最小面。 */
export interface PlaywrightBrowser {
  newPage(options?: { viewport?: { width: number; height: number } }): Promise<PlaywrightPage>
  close(): Promise<void>
}

/** Playwright chromium 门面的最小面。 */
export interface PlaywrightChromium {
  launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>
}

/** driver 解析结果：拿不到 driver 时如实说清尝试过什么。 */
export type PlaywrightResolution =
  | { readonly ok: true; readonly chromium: PlaywrightChromium; readonly label: string }
  | { readonly ok: false; readonly problems: readonly string[]; readonly hint: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pickChromium(mod: unknown): PlaywrightChromium | null {
  if (typeof mod !== 'object' || mod === null) return null
  const record = mod as Record<string, unknown>
  const fallback = typeof record.default === 'object' && record.default !== null ? (record.default as Record<string, unknown>) : undefined
  const candidate = record.chromium ?? fallback?.chromium
  if (typeof candidate !== 'object' || candidate === null) return null
  const chromium = candidate as Record<string, unknown>
  return typeof chromium.launch === 'function' ? (chromium as unknown as PlaywrightChromium) : null
}

/** 按「目录 → 目录/index.js」加载一个已安装的包目录（与 verify/browser.mjs 同口径）。 */
function requireDirectory(directory: string): unknown {
  try {
    return require(directory)
  } catch (first) {
    try {
      return require(join(directory, 'index.js'))
    } catch {
      throw first
    }
  }
}

/**
 * 解析 chromium：优先 DSH_VERIFY_PLAYWRIGHT（目录），再试裸包名 playwright。
 * 解析不到不抛，返回结构化失败——场景把这种情况判 blocked（装置缺失），不冒充产品红。
 */
export function loadPlaywright(playwrightDir?: string): PlaywrightResolution {
  const problems: string[] = []
  const override = playwrightDir ?? (typeof process.env.DSH_VERIFY_PLAYWRIGHT === 'string' ? process.env.DSH_VERIFY_PLAYWRIGHT : undefined)
  const candidates: { readonly label: string; readonly load: () => unknown }[] = []
  if (typeof override === 'string' && override.trim() !== '') {
    candidates.push({ label: 'DSH_VERIFY_PLAYWRIGHT=' + resolve(override), load: () => requireDirectory(resolve(override)) })
  }
  candidates.push({ label: 'playwright', load: () => require('playwright') })
  for (const candidate of candidates) {
    try {
      const chromium = pickChromium(candidate.load())
      if (chromium !== null) return { ok: true, chromium, label: candidate.label }
      problems.push(candidate.label + '：模块里没有 chromium.launch')
    } catch (error) {
      problems.push(candidate.label + '：' + errorMessage(error))
    }
  }
  return {
    ok: false,
    problems,
    hint:
      '设置 DSH_VERIFY_PLAYWRIGHT 指向已安装 playwright 的目录，或在验证环境里安装 playwright；' +
      '尝试过：' + problems.join('；'),
  }
}

/** 一次已建立的 UI 会话；close() 关浏览器（页面随上下文一起关）。 */
export interface UiSession {
  readonly page: PlaywrightPage
  readonly browser: PlaywrightBrowser
  readonly url: string
  readonly playwrightLabel: string
  close(): Promise<void>
}

/** 打开真 UI 的结果（结构化失败，方便场景判 blocked）。 */
export type OpenUiResult =
  | { readonly ok: true; readonly session: UiSession }
  | { readonly ok: false; readonly problems: readonly string[]; readonly hint: string }

/**
 * 用实例记录里的 tokenUrl 打开真 UI。
 *
 * 关键点：goto 必须带 token（cookie 握手），否则页面停在 origin root 并显示 authentication required；
 * 打开后等 body 有内容再交还，避免场景拿到半渲染 DOM 就下结论。
 */
export async function openAuthenticatedPage(
  tokenUrl: string,
  options: { readonly playwrightDir?: string; readonly headless?: boolean; readonly timeoutMs?: number } = {},
): Promise<OpenUiResult> {
  const resolution = loadPlaywright(options.playwrightDir)
  if (!resolution.ok) return { ok: false, problems: resolution.problems, hint: resolution.hint }
  const timeoutMs = options.timeoutMs ?? 30000
  let browser: PlaywrightBrowser | null = null
  try {
    browser = await resolution.chromium.launch({ headless: options.headless ?? true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(tokenUrl, { waitUntil: 'load', timeout: timeoutMs })
    let body = ''
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        body = await page.innerText('body')
      } catch (error) {
        body = ''
      }
      if (body.trim() !== '') break
      await sleep(250)
    }
    if (body.trim() === '') {
      await browser.close()
      return { ok: false, problems: ['页面打开后 body 一直为空（' + timeoutMs + 'ms）'], hint: '检查 tokenUrl 是否指向本次实例、宿主是否已完成 ready' }
    }
    const session: UiSession = {
      page,
      browser,
      url: page.url(),
      playwrightLabel: resolution.label,
      close: async () => {
        try {
          await browser?.close()
        } catch {
          // 浏览器已退出不影响证据结论
        }
      },
    }
    return { ok: true, session }
  } catch (error) {
    if (browser !== null) {
      try {
        await browser.close()
      } catch {
        // 尽力清理
      }
    }
    return { ok: false, problems: ['打开真 UI 失败：' + errorMessage(error)], hint: '确认 driver 与本机 Chromium 可用；tokenUrl 来自实例记录' }
  }
}

/** 读整页可见文本（body.innerText）；失败返回空串（调用方按需重试）。 */
export async function readBodyText(page: PlaywrightPage): Promise<string> {
  try {
    return await page.innerText('body')
  } catch (error) {
    return ''
  }
}

/**
 * 轮询 body 文本直到包含 needle（string 或 RegExp）。返回命中文本与最后一次观测，
 * 不抛超时——场景要把「没等到」如实写成断言失败，而不是把整个 run 炸掉。
 */
export async function waitForBodyText(
  page: PlaywrightPage,
  needle: string | RegExp,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<{ readonly matched: boolean; readonly body: string; readonly elapsedMs: number }> {
  const timeoutMs = options.timeoutMs ?? 15000
  const intervalMs = options.intervalMs ?? 250
  const startedAt = Date.now()
  let body = ''
  while (Date.now() - startedAt <= timeoutMs) {
    body = await readBodyText(page)
    const matched = typeof needle === 'string' ? body.includes(needle) : needle.test(body)
    if (matched) return { matched: true, body, elapsedMs: Date.now() - startedAt }
    await sleep(intervalMs)
  }
  return { matched: false, body, elapsedMs: Date.now() - startedAt }
}

/** 把旁注对象原样变成 sidecar 形状（纯函数；缺字段由 scenario-run 的校验器抓）。 */
export function buildShotSidecar(meta: ShotMeta): Record<string, string | null> {
  return {
    看什么: meta.what,
    步骤: meta.steps,
    expected: meta.expected,
    actual: meta.actual,
    判定: meta.verdict,
    备注: meta.note ?? null,
  }
}

/** 一张已落盘的截图。 */
export interface CapturedShot {
  readonly id: string
  readonly png: string
  readonly sidecar: string
  readonly bytes: number
}

/**
 * 截图 + 写同名六字段 sidecar。
 *
 * 顺序是先截 png、量到非零字节，再写 sidecar：sidecar 的 actual 是「这一张图实际是什么」的记录，
 * 不是预期抄件；截图失败直接抛，避免留下没有图的旁注。
 */
export async function captureShot(
  page: PlaywrightPage,
  shotsDir: string,
  id: string,
  meta: ShotMeta,
): Promise<CapturedShot> {
  await ensureDir(shotsDir)
  const png = join(shotsDir, id + '.png')
  const sidecar = join(shotsDir, id + '.json')
  await page.screenshot({ path: png, fullPage: false })
  const bytes = (await readFile(png)).byteLength
  if (bytes === 0) throw new Error('[base-verify] 截图文件为空：' + png)
  await writeJsonFile(sidecar, buildShotSidecar(meta))
  return { id, png, sidecar, bytes }
}

/** 是否显示成「未认证」页（goto 少 token / 握手失败时的症状）。 */
export function looksLikeAuthRequired(body: string): boolean {
  return body.toLowerCase().includes(AUTH_REQUIRED_MARKER)
}
