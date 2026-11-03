/**
 * selftest/real-machine/scenarios/l-boundary-gaps.ts —— 票 #284 B 组：用户可感知边界缺口（通道 B / web 宿主）。
 *
 * 五个 mode 对应五条声明（can-red 复用 L2 声明，用 run note/raw 标记注入）：
 *   - l1  l1-same-process-two-plugins-concurrent：同一 DSH web 宿主进程里 A、B 两个集成方各自装 0.0.1，
 *         同一页面两面板同时点安装 → 串行落定或后到者诚实忙碌（update-busy/gate-refused），失败方重试完成；
 *         磁盘/台账/UI 三面一致，重启后不回退。
 *   - l2  l2-registry-unreachable：A@0.0.1 在装、检查到 0.0.2 后杀掉本 run 私有 verdaccio（外部手段），
 *         真 UI 点安装 → 失败诚实（execute 非零/网络错误原话/无 retry storm/无假成功/人话格无载体命令）；
 *         同 storage/同端口重启 registry 后重试 → 真装成 0.0.2，台账恰一条成功终态，重启后如实展示。
 *   - l3  l3-permission-denied：icacls 拒绝写本 run profile 里目标包目录（外部手段），失败诚实；恢复后重试成功。
 *   - l4  l4-page-close-mid-install：延迟代理拉长安装窗，安装中关页面；宿主侧真装成、exactly-once、重开后与真相一致。
 *   - l5  l5-host-killed-mid-install-recovery：安装中 taskkill 本 run 宿主；重启后残留锁态度诚实；短阈值格陈旧锁回收。
 *
 * 真机纪律（照抄组 K/T3 做法）：
 *   - 通道 B（CLI 宿主）起 web 首页，Playwright 真页面点按钮；安装窗可安全轮询 DOM/磁盘；
 *   - 每 run 私有 DSH_HOME（os-home/.dsh）+ 独立 profile + 随机端口 + 仓库外 verdaccio；维护者真实 ~/.dsh 不碰；
 *   - 每 run 私有 pnpm store/cache 与 npm cache（避免跨 run 命中旧 packument/integrity）；
 *   - 产品的 registry 一律走本 run 的 TLS 前置（changelog 同源校验）；失败注入只用外部手段（杀进程/ACL/延迟），
 *     绝不改产品代码冒充失败；
 *   - 读日志一律在停宿主之后（dsh-log 有防抖，进程被杀会丢尾行）；
 *   - 试错 run 传 --no-evidence-sync，证据只进 runtime 目录；定稿 run 才复制进仓库。
 *
 * 证据只来自真机观测（DOM / 磁盘 / 台账 state.json / 递归日志 / registry 回包 / TLS 前置请求序列），不编造。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import type { TlsRegistryFront } from '../../fixtures/release/tls-registry-front.ts'
import { startTlsRegistryFront } from '../../fixtures/release/tls-registry-front.ts'
import type { VerdaccioHandle } from '../../fixtures/release/verdaccio-runtime.ts'
import { DEFAULT_LOCAL_ONLY_PACKAGES, startVerdaccio } from '../../fixtures/release/verdaccio-runtime.ts'
import { FIXTURE_BASE_VERSION, FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_VARIANT_VERSION, fixtureBuildTagsOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import type { LogEventRecord } from '../runtime/log-evidence.ts'
import { captureLogFiles, readLogEvents } from '../runtime/log-evidence.ts'
import { publishScenarioVariants } from '../runtime/scenario-runner.ts'
import type { RunManifest } from '../runtime/evidence.ts'
import { AUTH_REQUIRED_MARKER, loadPlaywright } from '../base-verify/web-ui.ts'
import type { PlaywrightBrowser, PlaywrightPage } from '../base-verify/web-ui.ts'
import { startCliHost } from '../host/cli-host.ts'
import type { CliHostSession } from '../host/cli-host.ts'
import { createWebProfileInHome, installedPluginDir } from '../host/isolated-profile.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { cardSelectorOf, copyRunEvidence, readDiskSnapshot, waitForDiskVersions } from './batch-helpers.ts'
import type { DiskSnapshot } from './batch-helpers.ts'
import { openT3Run, verifySutInstalled } from './t3-common.ts'
import type { T3Run } from './t3-common.ts'
import { directoryExists, ensureDir, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { sleep } from '../../tooling/process.ts'
import type { ManagedProcess } from '../../tooling/process.ts'

/** 组 L 的运行模式。 */
export type LBoundaryMode = 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'can-red'

/** 组 L 场景入参（与组 K 同形，mode 决定走哪一格）。 */
export interface LBoundaryScenarioOptions {
  /** 试错 run 传 false：不把 run.json/index.md/raw/shots 复制进仓库证据目录（定稿 run 才入库）。默认 true。 */
  syncEvidence?: boolean
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: LBoundaryMode
}

/** mode → 场景声明 id（can-red 复用 L2 声明，用 run note/raw 标记注入）。 */
const MODE_SCENARIO: Record<LBoundaryMode, string> = {
  l1: 'l1-same-process-two-plugins-concurrent',
  l2: 'l2-registry-unreachable',
  l3: 'l3-permission-denied',
  l4: 'l4-page-close-mid-install',
  l5: 'l5-host-killed-mid-install-recovery',
  'can-red': 'l2-registry-unreachable',
}

/** 通道 B 的 profile 名（不能是 desktop：产品对 desktop 有特殊路径）。 */
const PROFILE_NAME = 't13b'
/** UI 视口：比默认 1280x900 高，卡片/面板一次入画。 */
const VIEWPORT = { width: 1280, height: 1500 }
/** 一次安装（含 pnpm 取包）的最长等待。 */
const INSTALL_TIMEOUT_MS = 300000
/** UI/面板状态轮询的最长等待。 */
const PANEL_TIMEOUT_MS = 120000
/** 轮询间隔。 */
const POLL_MS = 300
/** 台账成功终态（completed=已收尾 / restart-required=待重启收尾）。 */
const SUCCESS_STATES = ['completed', 'restart-required'] as const
/** #284 重试安装的 UI 等待上限：检查→可安装→点击→宿主接单→磁盘到位，整段 90s；超时落 fail 断言。 */
const RETRY_VIA_UI_TIMEOUT_MS = 90000
/** 面板处于「安装已在飞/排队/检查中」的档位（这些档不能盲点 install）。 */
const IN_FLIGHT_KINDS = ['installing', 'busy', 'queued', 'checking', 'loading'] as const

type Verdict = 'pass' | 'fail' | 'known-red' | 'unknown'

/** 截图元数据（recorder.shot 要求 step 字段）。 */
interface ShotMeta {
  readonly step: string
  readonly what: string
  readonly expected: string
  readonly actual: string
  readonly verdict: Verdict
  readonly note?: string
}

/** 单包面板 DOM 读数（只保留本组用到的字段）。 */
interface PanelState {
  present: boolean
  plugin: string | null
  banner: { kind: string | null; title: string; sub: string } | null
  errCode: string | null
  settled: string
  lastResort: { present: boolean; badge: string; status: string; reason: string; copyText: string } | null
  manual: { present: boolean; heading: string; code: string | null; neutral: string } | null
  strip: string[]
  actions: { action: string | null; text: string; disabled: boolean }[]
  progress: string
}

/** Playwright 页面句柄。 */
interface UiHandle {
  readonly page: PlaywrightPage
  readonly browser: PlaywrightBrowser
  readonly label: string
  close(): Promise<void>
}

/** 一次宿主代（gen）的句柄。 */
interface HostGen {
  readonly index: number
  readonly host: CliHostSession
  readonly registryUrl: string
  readonly delayMs: number | null
  readonly requestsFrom: number
  ui: UiHandle | null
  stopped: boolean
}

/** 场景上下文（跨 gen 共享隔离环境）。 */
interface LBoundaryContext {
  readonly run: T3Run
  readonly mode: LBoundaryMode
  homeDir: string
  osHomeDir: string
  readonly profileName: string
  readonly registryUrl: string
  readonly front: TlsRegistryFront
  readonly gens: HostGen[]
  host: CliHostSession | null
  ui: UiHandle | null
  /** L2 杀掉的 registry 若在 run 内重启，句柄放这里由 cleanup 兜底停掉（防孤儿 verdaccio）。 */
  restartedRegistry: VerdaccioHandle | null
}

/** 台账条目（state.json）。 */
interface LedgerEntry {
  file: string
  state: Record<string, unknown>
  /** state.json 的修改时间（每插件/profile 只有一份，mtime 用来说明读取时刻）。 */
  mtimeMs: number
}

/** 造一个断言记录器（ok → pass/fail；可显式给 verdict）。 */
function recorderFor(run: T3Run) {
  return (meta: { step: string; what: string; expected: string; actual: string; ok: boolean; note?: string; verdict?: Verdict }): void => {
    run.record({
      step: meta.step,
      what: meta.what,
      expected: meta.expected,
      actual: meta.actual,
      verdict: meta.verdict ?? (meta.ok ? 'pass' : 'fail'),
      note: meta.note,
    })
  }
}

/** 把 Playwright page 适配成 batch-helpers 期待的 DesktopSession（cdp 面）。 */
function webSessionOf(page: PlaywrightPage): DesktopSession {
  const cdp = {
    evaluate: async (expression: string): Promise<unknown> => page.evaluate(expression),
    waitForExpression: async (expression: string, options?: { timeoutMs?: number }): Promise<void> => {
      const deadline = Date.now() + (options?.timeoutMs ?? 30000)
      while (Date.now() < deadline) {
        const matched = await page.evaluate<boolean>(expression).catch(() => false)
        if (matched) return
        await sleep(150)
      }
      throw new Error('waitForExpression 超时：' + expression.slice(0, 120))
    },
    waitForSelector: async (selector: string, options?: { timeoutMs?: number }): Promise<void> => {
      await page.waitForSelector(selector, { timeout: options?.timeoutMs ?? 30000 })
    },
    clickSelector: async (selector: string): Promise<void> => {
      const clicked = await page.evaluate<boolean>('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true})()')
      if (!clicked) throw new Error('clickSelector 找不到元素：' + selector)
    },
    scrollIntoView: async (selector: string): Promise<void> => {
      await page.evaluate('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(el)el.scrollIntoView({block:"center"})})()')
    },
    pageText: async (): Promise<string> => page.innerText('body'),
    screenshot: async (): Promise<Uint8Array> => {
      const tmpPath = join(tmpdir(), 'l-boundary-adapter-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png')
      await page.screenshot({ path: tmpPath })
      const bytes = new Uint8Array(await readFile(tmpPath))
      await rm(tmpPath, { force: true })
      return bytes
    },
    close: async (): Promise<void> => undefined,
  }
  const adapter = {
    port: 0,
    process: {} as ManagedProcess,
    cdp,
    targets: [],
    stdout: (): string => '',
    stderr: (): string => '',
    close: async (): Promise<void> => undefined,
  }
  return adapter as unknown as DesktopSession
}

/** 打开带 token 的 UI 页面。 */
async function openUi(tokenUrl: string): Promise<UiHandle> {
  const resolution = loadPlaywright(process.env['DSH_VERIFY_PLAYWRIGHT'])
  if (!resolution.ok) {
    throw new Error('Playwright 不可用：' + resolution.problems.join('；') + '（' + resolution.hint + '）')
  }
  const browser = await resolution.chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.goto(tokenUrl, { waitUntil: 'load', timeout: 60000 })
  const deadline = Date.now() + 30000
  let body = ''
  while (Date.now() < deadline) {
    body = await page.innerText('body').catch(() => '')
    if (body.trim().length > 0) break
    await sleep(250)
  }
  if (body.includes(AUTH_REQUIRED_MARKER)) throw new Error('UI 鉴权失败（body 含 authentication required）')
  // 首启弹窗「预览版说明」会盖住真机截图：只点精确文案「继续」的按钮，最多等 5 秒（不点其它任何按钮）。
  const dismissDeadline = Date.now() + 5000
  while (Date.now() < dismissDeadline) {
    const clicked = await page.evaluate<boolean>('(function(){var bs=Array.prototype.slice.call(document.querySelectorAll("button"));for(var i=0;i<bs.length;i++){var b=bs[i];if(String(b.textContent||"").trim()==="继续"){b.click();return true}}return false})()').catch(() => false)
    if (clicked) { await sleep(300); continue }
    const stillThere = await page.evaluate<boolean>('(function(){return Array.prototype.slice.call(document.querySelectorAll("button")).some(function(b){return String(b.textContent||"").trim()==="继续"})})()').catch(() => false)
    if (!stillThere) break
    await sleep(250)
  }
  return {
    page,
    browser,
    label: resolution.label,
    close: async (): Promise<void> => {
      await page.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
    },
  }
}

/** 整窗截图并登记（recorder.shot 写 shots/<id>.png + sidecar 进 run.json）。 */
async function capture(run: T3Run, ui: UiHandle, meta: ShotMeta): Promise<void> {
  const tmpPath = join(run.layout.rawDir, 'ui-shot-' + Date.now() + '.png')
  await ui.page.screenshot({ path: tmpPath })
  const png = new Uint8Array(await readFile(tmpPath))
  await rm(tmpPath, { force: true })
  await run.recorder.shot('shot', png, meta)
}

/** 等待 body 文本出现（用于等待卡片挂载）。 */
async function waitForBody(ui: UiHandle, needle: string, label: string, timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let body = ''
  while (Date.now() < deadline) {
    body = await ui.page.innerText('body').catch(() => '')
    if (body.indexOf(needle) >= 0) return body
    await sleep(POLL_MS)
  }
  throw new Error('等待文案超时（' + label + '）：' + needle)
}

/** 单包面板读数脚本（按卡片 + plugin 选择器定位，不依赖全局第一个 .dsh-upd）。 */
function panelScript(cardSelector: string, pluginSelector: string): string {
  return '(function(){' +
    'var card=document.querySelector(' + JSON.stringify(cardSelector) + ');' +
    'if(!card)return null;' +
    'var root=card.querySelector(' + JSON.stringify(pluginSelector) + ');' +
    'if(!root)return {present:false,plugin:null};' +
    'function txt(el){return el?String(el.textContent||"").trim():""}' +
    'function q(s){return root.querySelector(s)}' +
    'function qa(s){return Array.prototype.slice.call(root.querySelectorAll(s))}' +
    'var b=q(".dsh-upd-banner");' +
    'var settleEl=q(".dsh-upd-settled");' +
    'var banner=b?{kind:b.getAttribute("data-kind"),title:txt(b.querySelector("strong")||b),sub:txt(q(".dsh-upd-banner-sub"))}:null;' +
    'var lr=q(".dsh-upd-lastresort");' +
    'var lastResort=lr?{present:true,badge:txt(lr.querySelector(".dsh-upd-lr-badge")),status:txt(lr.querySelector(".dsh-upd-lr-status")),reason:txt(lr.querySelector(".dsh-upd-lr-reason")),copyText:txt(lr.querySelector(".dsh-upd-lr-go"))}:null;' +
    'var m=q(".dsh-upd-manual");' +
    'var manual=m?{present:true,heading:txt(m.querySelector("div")),code:txt(m.querySelector("code"))||null,neutral:txt(m.querySelector(".dsh-upd-changelog-neutral"))}:null;' +
    'var actions=qa("button[data-action]").map(function(el){return {action:el.getAttribute("data-action"),text:txt(el),disabled:el.disabled===true||el.hasAttribute("disabled")}});' +
    'return {present:true,plugin:root.getAttribute("data-plugin"),banner:banner,errCode:txt(q(".dsh-upd-err code"))||null,settled:txt(settleEl),lastResort:lastResort,manual:manual,strip:qa(".dsh-upd-strip-v").map(txt),actions:actions,progress:txt(q(".dsh-upd-progtxt"))};' +
    '})()'
}

/** 读单包面板；卡片/面板未挂载时返回 null。 */
async function readPanel(ui: UiHandle, cardSelector: string, pluginSelector: string): Promise<PanelState | null> {
  return ui.page.evaluate<PanelState | null>(panelScript(cardSelector, pluginSelector)).catch(() => null)
}

/** 在卡片内按 selector 点击（滚动到可视区后 click）。 */
async function clickInCard(ui: UiHandle, cardSelector: string, selector: string): Promise<void> {
  const clicked = await ui.page.evaluate<boolean>('(function(){var card=document.querySelector(' + JSON.stringify(cardSelector) + ');if(!card)return false;var el=card.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true})()')
  if (!clicked) throw new Error('点击失败（卡片内找不到）：' + cardSelector + ' ' + selector)
}

/** 轮询单包面板直到 predicate 成立。 */
async function waitForPanel(ui: UiHandle, cardSelector: string, pluginSelector: string, predicate: (state: PanelState) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<PanelState> {
  const deadline = Date.now() + timeoutMs
  let last: PanelState | null = null
  while (Date.now() < deadline) {
    last = await readPanel(ui, cardSelector, pluginSelector)
    if (last && last.present && predicate(last)) return last
    await sleep(POLL_MS)
  }
  throw new Error('等待面板状态超时（' + label + '）：last=' + JSON.stringify(last ? last.banner : null))
}

/** 取宿主代的 UI 会话（没有就抛）。 */
function uiOf(gen: HostGen): UiHandle {
  if (!gen.ui) throw new Error('宿主代 ' + gen.index + ' 没有 UI 会话')
  return gen.ui
}

/** 发布记录 → '包名@版本' 摘要。 */
function specMap(record: Record<string, PublishedFixture>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) result[key] = value.plan.packageName + '@' + value.plan.version
  return result
}

/** 读某包的卡片构建标记（clientTag/hostTag）。 */
async function readCardTags(ui: UiHandle, cardSelector: string): Promise<{ clientTag: string | null; hostTag: string | null }> {
  return ui.page.evaluate<{ clientTag: string | null; hostTag: string | null }>('(function(){' +
    'var card=document.querySelector(' + JSON.stringify(cardSelector) + ');' +
    'if(!card)return {clientTag:null,hostTag:null};' +
    'var host=card.querySelector("[data-fixture-host-tag]");' +
    'return {clientTag:card.getAttribute("data-build-tag"),hostTag:host?String(host.textContent||"").trim():null};' +
    '})()')
}

/** 造/准备 run 的隔离环境：profile、pnpm store、SUT 校验、基版磁盘核对、变体发布。 */
async function prepareRun(run: T3Run, options: LBoundaryScenarioOptions): Promise<LBoundaryContext> {
  const fixtureEnv = run.fixtureEnv
  if (!fixtureEnv) throw new Error('L 场景必须有夹具环境（openT3Run 应带 withFixtures）')
  const osHomeDir = join(run.layout.root, 'os-home')
  const homeDir = join(osHomeDir, '.dsh')
  await ensureDir(osHomeDir)
  await ensureDir(homeDir)
  const storeDir = join(run.layout.root, 'pnpm-store')
  await ensureDir(storeDir)
  // pnpm 的 registry 元数据缓存（cache-dir）默认是用户全局目录，键里带 registry origin（含端口）。
  // 与本 run 复用同一端口的旧 run 会把旧 integrity 带进来（ERR_PNPM_TARBALL_INTEGRITY），
  // 所以 cache-dir 也必须按 run 隔离，和 store 一样从 profile 建好前就生效。
  process.env['pnpm_config_store_dir'] = storeDir
  const cacheDir = join(run.layout.root, 'pnpm-cache')
  await ensureDir(cacheDir)
  process.env['pnpm_config_cache_dir'] = cacheDir
  process.env['npm_config_cache'] = join(run.layout.root, 'npm-cache')
  // 产品取更新日志要求 dist.tarball 是 https 且与 registry 同源，所以产品侧的 registry 一律走本 run 的 TLS 前置；
  // verdaccio 仍是仓库外 http，只当上游。
  const front = await startTlsRegistryFront({ upstreamBaseUrl: fixtureEnv.registry.baseUrl, certificateDir: join(run.layout.root, 'tls-registry-front') })
  await run.registerPort('tls-registry-front', front.port)
  const ctx: LBoundaryContext = { run, mode: options.mode, homeDir, osHomeDir, profileName: PROFILE_NAME, registryUrl: front.baseUrl, front, gens: [], host: null, ui: null, restartedRegistry: null }
  await run.raw('tls-registry-front', { baseUrl: ctx.registryUrl, port: front.port, upstream: fixtureEnv.registry.baseUrl, certPath: front.certPath, certSha256: front.certSha256, requests: front.requests().length })
  await run.raw('isolation-facts', {
    osHomeDir,
    homeDir,
    profileName: PROFILE_NAME,
    pnpmStoreDir: storeDir,
    pnpmCacheDir: cacheDir,
    npmCacheDir: process.env['npm_config_cache'] || null,
    registryUrl: ctx.registryUrl,
    upstreamRegistryUrl: fixtureEnv.registry.baseUrl,
    upstreamRegistryPort: fixtureEnv.registry.port,
    playwrightDir: process.env['DSH_VERIFY_PLAYWRIGHT'] || null,
    node: process.version,
    platform: process.platform,
  })
  createWebProfileInHome({ homeDir, profileName: PROFILE_NAME })
  const baseline = await run.publishBaseline()
  await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl: fixtureEnv.registry.baseUrl })
  const sutOk = await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName: fixtureEnv.sut.name })
  recorderFor(run)({ step: 'setup-sut', what: '通道 B profile 里装的 SUT 与工作树构建一致', expected: 'installed distDigest === worktree distDigest', actual: String(sutOk), ok: sutOk })
  const expectedBase: Record<string, string> = {}
  for (const step of run.scenario.install) expectedBase[fixtureSlotOf(step.slotKey).packageName] = step.version
  const baseDisk = await diskVersions(ctx, Object.keys(expectedBase))
  let baseOk = true
  const baseDetail: string[] = []
  for (const [packageName, version] of Object.entries(expectedBase)) {
    const actual = baseDisk[packageName] ?? null
    if (actual !== version) baseOk = false
    baseDetail.push(packageName + '=' + String(actual))
  }
  recorderFor(run)({ step: 'setup-base-disk', what: '基版安装后磁盘版本与声明一致', expected: JSON.stringify(expectedBase), actual: baseDetail.join(', '), ok: baseOk })
  const publication = await publishScenarioVariants(run.scenario, fixtureEnv, undefined, baseline)
  await run.raw('fixture-publication', { baseline: specMap(publication.baseline), variants: specMap(publication.variants), injected: publication.injected })
  return ctx
}

/** 起一代宿主（可选延迟代理；默认同时开 UI）。 */
async function startHostGen(ctx: LBoundaryContext, label: string, options: { delayMs?: number; match?: 'pnpm-user-agent' | 'all'; withUi?: boolean; extraEnv?: Record<string, string> } = {}): Promise<HostGen> {
  const delayMs = options.delayMs && options.delayMs > 0 ? options.delayMs : null
  ctx.front.setDelay(delayMs === null ? null : { delayMs, match: options.match ?? 'pnpm-user-agent' })
  const requestsFrom = ctx.front.requests().length
  const host = await startCliHost({
    homeDir: ctx.homeDir,
    osHomeDir: ctx.osHomeDir,
    profileName: PROFILE_NAME,
    // 产品侧 registry = 本 run 的 TLS 前置；自签证书靠 NODE_EXTRA_CA_CERTS 注入宿主与它 spawn 的 CLI/pnpm。
    extraEnv: { DSH_SELFTEST_REGISTRY: ctx.registryUrl, NODE_EXTRA_CA_CERTS: ctx.front.certPath, ...(options.extraEnv ?? {}) },
  })
  ctx.run.registerProcess(label + '-host', host.pid() ?? null)
  await ctx.run.registerPort(label + '-host-port', host.port)
  const gen: HostGen = { index: ctx.gens.length, host, registryUrl: ctx.registryUrl, delayMs, requestsFrom, ui: null, stopped: false }
  ctx.gens.push(gen)
  await ctx.run.raw('host-launch-' + label, {
    label,
    urlMasked: host.url.replace(/token=[^&]+/, 'token=***'),
    port: host.port,
    bootMs: host.bootMs,
    registryUrl: ctx.registryUrl,
    tlsFrontPort: ctx.front.port,
    certSha256: ctx.front.certSha256,
    delayMs,
    requestsFrom,
    stdoutTail: host.stdout().slice(-1600),
    stderrTail: host.stderr().slice(-1600),
  })
  if (options.withUi !== false) {
    gen.ui = await openUi(host.url)
    ctx.run.addNote('宿主 ' + label + ' 已起：port=' + host.port + '，UI=' + gen.ui.label + '（registry=' + ctx.registryUrl + '）')
  }
  ctx.host = host
  ctx.ui = gen.ui
  return gen
}

/** 停一代宿主（UI → 宿主 → 延迟代理），并登记 raw。 */
async function stopHostGen(ctx: LBoundaryContext, gen: HostGen, reason = 'stop'): Promise<void> {
  if (gen.stopped) return
  gen.stopped = true
  const port = gen.host.port
  const pid = gen.host.pid()
  if (gen.ui) {
    await gen.ui.close().catch(() => undefined)
    gen.ui = null
  }
  await gen.host.close().catch(() => undefined)
  ctx.front.setDelay(null)
  const registryRequests = ctx.front.requests().slice(gen.requestsFrom)
  const proxyRequests = registryRequests.length
  const delayedRequests = registryRequests.filter((item) => item.delayed).length
  if (ctx.host === gen.host) {
    ctx.host = null
    ctx.ui = null
  }
  await ctx.run.raw('host-stop-' + gen.index, { reason, gen: gen.index, port, pid: pid ?? null, registryUrl: gen.registryUrl, delayMs: gen.delayMs, proxyRequests, delayedRequests })
}

/** 收尾：停掉所有未停的宿主代、重启的 registry，并在全部宿主停后统一收割日志。 */
async function cleanupContext(ctx: LBoundaryContext, options: { stopFront?: boolean } = {}): Promise<void> {
  for (const gen of ctx.gens) {
    if (!gen.stopped) await stopHostGen(ctx, gen, 'cleanup')
  }
  if (ctx.restartedRegistry) {
    const port = ctx.restartedRegistry.port
    const stdout = ctx.restartedRegistry.stdout()
    const stderr = ctx.restartedRegistry.stderr()
    try {
      await ctx.restartedRegistry.stop()
      await ctx.run.registerPort('verdaccio-restarted', port)
    } catch (error) {
      ctx.run.addNote('收尾停重启的 verdaccio 失败：' + (error instanceof Error ? error.message : String(error)))
    }
    await ctx.run.raw('l2-restarted-registry-stop', { port, stdoutTail: stdout.slice(-2000), stderrTail: stderr.slice(-2000) })
    ctx.restartedRegistry = null
  }
  try {
    const capture = await captureLogFiles(ctx.run.recorder, ctx.homeDir)
    await ctx.run.raw('cleanup-log-files', { files: capture.snapshot.files, eventCount: capture.snapshot.events.length, truncations: capture.truncations.length })
  } catch (error) {
    ctx.run.addNote('日志收割失败：' + (error instanceof Error ? error.message : String(error)))
  }
  if (options.stopFront === false) return
  const frontRequests = ctx.front.requests()
  await ctx.run.raw('tls-front-stop', { port: ctx.front.port, requests: frontRequests.length, delayed: ctx.front.delayedCount(), certSha256: ctx.front.certSha256 })
  await ctx.front.stop().catch(() => undefined)
}

/** 读磁盘版本（按 packageName）。 */
async function diskVersions(ctx: LBoundaryContext, packageNames: readonly string[]): Promise<Record<string, string | null>> {
  const snapshot: DiskSnapshot = await readDiskSnapshot({ homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageNames })
  return snapshot.versions
}

/** 等磁盘版本到位。 */
async function waitDiskVersions(ctx: LBoundaryContext, expected: Record<string, string>, label: string): Promise<void> {
  await waitForDiskVersions({ homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageNames: Object.keys(expected) }, expected, { label, timeoutMs: INSTALL_TIMEOUT_MS })
}

/** 读全部台账 state.json。 */
async function ledgerStates(ctx: LBoundaryContext): Promise<LedgerEntry[]> {
  const root = join(ctx.homeDir, 'updates')
  if (!(await directoryExists(root))) return []
  const files = (await listFilesRecursive(root)).filter((file) => file.endsWith('state.json')).sort()
  const entries: LedgerEntry[] = []
  for (const file of files) {
    const normalized = file.split('\\').join('/')
    // listFilesRecursive 返回的是相对 root 的路径，读文件必须先解析成绝对路径（否则 readFile 相对进程 cwd → 误判 corrupt）。
    const absolute = isAbsolute(file) ? file : join(root, file)
    let mtimeMs = 0
    try {
      mtimeMs = (await stat(absolute)).mtimeMs
    } catch {
      mtimeMs = 0
    }
    let parsed: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 3 && parsed === null; attempt += 1) {
      try {
        parsed = JSON.parse(await readFile(absolute, 'utf8')) as Record<string, unknown>
      } catch {
        await sleep(50)
      }
    }
    entries.push({ file: normalized, state: parsed ?? { corrupt: true }, mtimeMs })
  }
  return entries
}

/** 夹具插件在宿主里的短 id 末段（包名 dsh-plugin-update-fixture-a ↔ 日志/台账目录 fxa-a 等，末段一致）。 */
function pluginShortIdOf(packageName: string): string {
  return packageName.slice(packageName.lastIndexOf('-') + 1)
}

/** 日志 pluginId 是否指向该包（日志里单包 pluginId 是更新电话前缀 fxa-a，不是包名）。 */
function isPluginEventOf(pluginId: string, packageName: string): boolean {
  return pluginId === packageName || (pluginId !== '' && pluginId.endsWith('-' + pluginShortIdOf(packageName)))
}

/** 台账目录是否属于该包（目录名 fxa-a/fxa-b/…；同末段即可）。 */
function isLedgerPathOf(file: string, packageName: string): boolean {
  const segments = file.split('/')
  return segments.some((segment) => segment === packageName || (segment !== '' && segment.endsWith('-' + pluginShortIdOf(packageName))))
}

/** 某插件的全部台账记录（同一插件的多次尝试各一份 state.json），按修改时间新→旧。 */
async function ledgerJobsOf(ctx: LBoundaryContext, packageName: string): Promise<LedgerEntry[]> {
  const entries = await ledgerStates(ctx)
  return entries.filter((entry) => isLedgerPathOf(entry.file, packageName)).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 台账里某插件最新一份记录（找不到 null）。状态目录按插件+profile 派生，同一组合只有一份 state.json（重试覆盖）。 */
async function ledgerFor(ctx: LBoundaryContext, packageName: string): Promise<LedgerEntry | null> {
  const hits = await ledgerJobsOf(ctx, packageName)
  return hits.length > 0 ? hits[0] as LedgerEntry : null
}

/** 台账 state 字段。 */
function ledgerStateOf(entry: LedgerEntry | null): string {
  if (!entry) return 'missing'
  const value = entry.state['state']
  return typeof value === 'string' ? value : 'unknown'
}

/** 台账 message 字段（最后一条）。 */
function ledgerMessageOf(entry: LedgerEntry | null): string {
  if (!entry) return ''
  const value = entry.state['message']
  return typeof value === 'string' ? value : ''
}

/** 台账记录是否成功终态（completed / restart-required）。 */
function isSuccessLedger(entry: LedgerEntry | null): boolean {
  return entry !== null && (SUCCESS_STATES as readonly string[]).indexOf(ledgerStateOf(entry)) >= 0
}

/** 轮询台账直到某插件状态命中。 */
async function waitForLedger(ctx: LBoundaryContext, packageName: string, wanted: readonly string[], label: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<LedgerEntry | null> {
  const deadline = Date.now() + timeoutMs
  let last = 'missing'
  while (Date.now() < deadline) {
    const entry = await ledgerFor(ctx, packageName)
    last = ledgerStateOf(entry)
    if (wanted.indexOf(last) >= 0) return entry
    await sleep(POLL_MS)
  }
  ctx.run.addNote('等台账超时（' + label + '）：' + packageName + ' 最后状态=' + last + '，期望 ' + wanted.join('|'))
  return ledgerFor(ctx, packageName)
}

/** 读当前递归日志事件（宿主运行中也可读；只用于冻结/中间观测）。 */
async function readEvents(ctx: LBoundaryContext): Promise<LogEventRecord[]> {
  const snapshot = await readLogEvents(ctx.homeDir)
  return snapshot.events
}

/** 按事件名筛。 */
function eventsNamed(events: readonly LogEventRecord[], name: string): LogEventRecord[] {
  return events.filter((event) => event.event === name)
}

/** 事件是否属于该包：优先 fields.pluginId；失败行等字段里没有 pluginId，退回日志来源命名空间（fxa-a/...）。 */
function isEventOfPackage(event: LogEventRecord, packageName: string): boolean {
  return isPluginEventOf(String(event.fields['pluginId'] || ''), packageName) || isLedgerPathOf(String(event.source || ''), packageName)
}

/** 某插件（包名）的安装执行事件（fields.pluginId 或 source 命名空间匹配）。 */
function installExecsOf(events: readonly LogEventRecord[], packageName: string): LogEventRecord[] {
  return events.filter((event) => event.event === 'update.install.exec' && isEventOfPackage(event, packageName))
}

/** 某插件的安装失败事件。 */
function installFailsOf(events: readonly LogEventRecord[], packageName: string): LogEventRecord[] {
  return events.filter((event) => event.event === 'update.install.fail' && isEventOfPackage(event, packageName))
}

/** 某插件的安装请求事件（update.install.request）。 */
function installRequestsOf(events: readonly LogEventRecord[], packageName: string): LogEventRecord[] {
  return events.filter((event) => event.event === 'update.install.request' && isEventOfPackage(event, packageName))
}

/** 成功 exec 计数。 */
function okExecCount(records: readonly LogEventRecord[]): number {
  return records.filter((record) => record.fields['ok'] === true).length
}

/** 对某 URL 做一次短探活（evidence：registry 杀前/杀后/恢复后）。 */
async function pingRegistry(baseUrl: string): Promise<{ ok: boolean; status: number | null; error: string | null; bodyText: string }> {
  try {
    // 不用 AbortSignal（selftest 的 fetch 类型面没有 signal 选项），用 Promise.race 加超时；
    // verdaccio 停止后端口立刻拒绝连接，正常会秒回错误，超时只是兜底防止挂死。
    const response = await Promise.race([
      fetch(baseUrl + '/-/ping'),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('ping 超时（4000ms）')), 4000)
      }),
    ])
    const bodyText = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, error: null, bodyText: bodyText.slice(0, 300) }
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error), bodyText: '' }
  }
}

/** 网络类失败的原话检测（detail/日志里必须出现真实网络错误，而不是空泛未知错误）。 */
const NETWORK_ERROR_TOKEN = /(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|ERR_PNPM_FETCH|ERR_PNPM_META_FETCH_FAIL|network|网络|连接被拒绝|无法连接)/i

/** 载体命令形状（#267：registry/网络类失败的人话格不得出现这条命令；手工备用区另算）。 */
const CARRIER_COMMAND_SHAPE = /dsh\s+plugin\s+--profile\s+\S+\s+add\s+--save-exact\s+/i

/** 把事件字段压成可写 raw 的浅对象。 */
function eventFactOf(event: LogEventRecord): Record<string, unknown> {
  return { source: event.source, event: event.event, level: event.level, fields: event.fields }
}

/** L2：registry 整体不可达 → 失败诚实；同 storage/同端口恢复后重试成功、台账恰一条成功终态、重启后如实展示。 */
async function runL2(ctx: LBoundaryContext, options: LBoundaryScenarioOptions): Promise<void> {
  const rec = recorderFor(ctx.run)
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('L2 需要夹具环境（run.fixtureEnv 为空）')
  const packageA = FIXTURE_SLOT_A.packageName
  const cardA = cardSelectorOf('a')
  const panelA = '.dsh-upd[data-plugin="' + packageA + '"]'
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)

  // ---- 1. 真 UI：检查到 0.0.2 可更新（失败注入前的对照） ----
  const gen1 = await startHostGen(ctx, 'l2-gen1')
  const ui1 = uiOf(gen1)
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'A 面板初始状态回填')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  const update = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', '检查后给出可更新 0.0.2')
  const updateOk = update.banner !== null && update.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。'
  await capture(ctx.run, ui1, {
    step: 'l2-10-check-before-kill',
    what: '杀 registry 前对照：真 UI 点「检查更新」后面板列出 0.0.2 可更新',
    expected: '横幅标题精确等于「有新版本 0.0.2 可安装（当前版本 0.0.1）。」',
    actual: JSON.stringify(update.banner),
    verdict: updateOk ? 'pass' : 'fail',
  })
  rec({ step: 'l2-01-check-before-kill', what: '失败注入前检查更新可用（失败后的可归因性依赖这一格）', expected: '可更新横幅原文精确匹配', actual: JSON.stringify(update.banner), ok: updateOk })

  // ---- 2. 外部手段杀本 run 私有 verdaccio（不在产品里造假） ----
  const registry = fixtureEnv.registry
  const upstreamPingBefore = await pingRegistry(registry.baseUrl)
  const stdoutBefore = registry.stdout()
  const stderrBefore = registry.stderr()
  const killedAt = new Date().toISOString()
  await registry.verdaccio.stop()
  await ctx.run.registerPort('verdaccio-killed', registry.port)
  const upstreamPingAfter = await pingRegistry(registry.baseUrl)
  const killFacts = { port: registry.port, baseUrl: registry.baseUrl, killedAt, pingBefore: upstreamPingBefore, pingAfter: upstreamPingAfter, stdoutTail: stdoutBefore.slice(-3000), stderrTail: stderrBefore.slice(-3000) }
  await ctx.run.raw('l2-registry-kill', killFacts)
  const killOk = upstreamPingBefore.ok && !upstreamPingAfter.ok
  await capture(ctx.run, ui1, {
    step: 'l2-15-registry-killed',
    what: '本 run 私有 verdaccio 已被停（外部手段）：registry 探活从 200 变为不可达；页面仍在但安装将失败',
    expected: '杀前 /-/ping 200、杀后连接失败；注入命令与输出入 raw',
    actual: JSON.stringify({ pingBefore: { ok: upstreamPingBefore.ok, status: upstreamPingBefore.status }, pingAfter: { ok: upstreamPingAfter.ok, error: upstreamPingAfter.error } }),
    verdict: killOk ? 'pass' : 'fail',
  })
  rec({ step: 'l2-02-registry-killed', what: 'registry 整体不可达（外部注入，真机事实）', expected: '杀前 ping ok=true、杀后 ping ok=false（端口已释放）', actual: JSON.stringify({ pingBefore: { ok: upstreamPingBefore.ok, status: upstreamPingBefore.status }, pingAfter: { ok: upstreamPingAfter.ok, status: upstreamPingAfter.status, error: upstreamPingAfter.error } }), ok: killOk })

  // ---- 3. 真 UI 点安装 → 失败必须诚实 ----
  const installClickAt = new Date().toISOString()
  await clickInCard(ui1, cardA, panelA + ' button[data-action="install"]')
  const failed = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'failed', 'registry 不可达时安装失败横幅', INSTALL_TIMEOUT_MS)
  await sleep(800)
  const failedFull = (await readPanel(ui1, cardA, panelA)) as PanelState
  const failBanner = failedFull.banner
  const failTitle = failBanner ? failBanner.title : ''
  const failSub = failBanner ? failBanner.sub : ''
  const failCode = failedFull.errCode
  // 产品的安装路径在真正 spawn pnpm 前会复核候选版本（saveJob 之前）；registry 已死时这一复核失败在 gate：
  // 不跑 pnpm、不落 job、不给假成功。这是产品真实行为；若产品走到 exec 失败（pnpm 已跑），也按自洽口径断言。
  const failBannerOk = failBanner !== null && failTitle.indexOf('更新失败') >= 0 && failCode !== null && failCode.length > 0
  const panelNotDone = failBanner === null || failBanner.kind !== 'done'
  const failObservedAt = new Date().toISOString()
  // 宿主还活着时先读一次日志计数，8s 后再读一次：两次数值相同才算「无自动重试风暴」（不必等停宿主）。
  const liveAfterFail = await readEvents(ctx)
  const countAtFail = {
    requests: installRequestsOf(liveAfterFail, packageA).length,
    execs: installExecsOf(liveAfterFail, packageA).length,
    fails: installFailsOf(liveAfterFail, packageA).length,
  }
  await capture(ctx.run, ui1, {
    step: 'l2-20-failure-panel',
    what: 'registry 不可达时真 UI 点安装：失败横幅（人话格）+ 错误码 + 手工备用区（若有）',
    expected: '横幅 kind=failed、标题含「更新失败」、errCode 非空且指向真实失败类别；不得呈现「已是最新」/更新成功',
    actual: JSON.stringify({ banner: failBanner, bannerKind: failed.banner ? failed.banner.kind : null, errCode: failCode, manual: failedFull.manual, lastResort: failedFull.lastResort }),
    verdict: failBannerOk && panelNotDone ? 'pass' : 'fail',
  })
  rec({ step: 'l2-03-failure-banner', what: '安装失败面是失败档而不是假成功', expected: 'kind=failed、标题含「更新失败」、errCode 非空', actual: JSON.stringify({ banner: failBanner, errCode: failCode }), ok: failBannerOk && panelNotDone })

  // 失败后静置 8s（观察窗）：产品不得自动重试（无 retry storm）。
  await sleep(8000)
  const windowEndAt = new Date().toISOString()
  const liveAfterWindow = await readEvents(ctx)
  const countAtWindowEnd = {
    requests: installRequestsOf(liveAfterWindow, packageA).length,
    execs: installExecsOf(liveAfterWindow, packageA).length,
    fails: installFailsOf(liveAfterWindow, packageA).length,
  }
  const liveCountsStable = countAtFail.requests === countAtWindowEnd.requests && countAtFail.execs === countAtWindowEnd.execs && countAtFail.fails === countAtWindowEnd.fails
  await ctx.run.raw('l2-failure-window', {
    installClickAt,
    failObservedAt,
    windowEndAt,
    windowMs: 8000,
    countsAtFail: countAtFail,
    countsAtWindowEnd: countAtWindowEnd,
    note: '安装失败后静置 8s，宿主存活期间前后两次读日志计数：必须相同（无 retry storm）',
  })

  // ---- 4. 停宿主后统一收割事实 ----
  await stopHostGen(ctx, gen1, 'l2-after-failure')
  const events1 = await readEvents(ctx)
  const execs1 = installExecsOf(events1, packageA)
  const fails1 = installFailsOf(events1, packageA)
  const requests1 = installRequestsOf(events1, packageA)
  const execPath = countAtFail.execs > 0
  // gate 失败不打开 job（不落 state.json）；exec 失败必须落 failed。两者都不许出现成功终态。
  const ledger1 = execPath ? await waitForLedger(ctx, packageA, ['failed'], 'L2 exec 失败后台账落 failed', 60000) : (await sleep(1500), await ledgerFor(ctx, packageA))
  const diskAfterFail = await diskVersions(ctx, [packageA])
  const failFacts = asFactList(fails1)
  const execFacts = asFactList(execs1)
  const failStage = fails1.length === 1 ? String(fails1[0]?.fields['stage'] || '') : ''
  const failReason = fails1.length === 1 ? String(fails1[0]?.fields['reason'] || '') : ''
  const failCodeLogged = fails1.length === 1 ? String(fails1[0]?.fields['code'] || '') : ''
  const messageText = ledgerMessageOf(ledger1)
  const detailText = [failTitle, failSub, messageText, JSON.stringify(failFacts), JSON.stringify(execFacts)].join(' | ')
  const humanText = [failTitle, failSub, messageText].join(' | ')
  const humanNetwork = NETWORK_ERROR_TOKEN.test(humanText)
  const detailHasNetwork = NETWORK_ERROR_TOKEN.test(detailText)
  const injectionError = upstreamPingAfter.error
  const carrierInHuman = CARRIER_COMMAND_SHAPE.test(humanText)
  // 失败码必须与「到底走到哪一步」自洽：check-failed=gate 拒绝、不跑 pnpm、不落 job；
  // install-failed=exec 真跑了且非零退出、台账 failed。
  const pathConsistent = failCode === 'check-failed'
    ? failStage === 'gate' && failReason === 'gate-refused' && failCodeLogged === 'check-failed' && execs1.length === 0 && !isSuccessLedger(ledger1)
    : failCode === 'install-failed'
      ? failStage === 'exec' && failCodeLogged === 'install-failed' && execs1.length >= 1 && okExecCount(execs1) === 0 && ledgerStateOf(ledger1) === 'failed'
      : false
  const noRetryOk = requests1.length === 1 && fails1.length === 1 && (failCode === 'check-failed' ? execs1.length === 0 : execs1.length >= 1) && liveCountsStable
  const diskUnchanged = diskAfterFail[packageA] === FIXTURE_BASE_VERSION
  const ledgerNoFalseSuccess = !isSuccessLedger(ledger1)
  await ctx.run.raw('l2-failure-facts', {
    installClickAt,
    execPath,
    execs: execFacts,
    fails: failFacts,
    requests: requests1.map(eventFactOf),
    ledger: ledger1 ? { file: ledger1.file, state: ledger1.state, mtimeMs: ledger1.mtimeMs } : null,
    disk: diskAfterFail,
    banner: failBanner,
    errCode: failCode,
    manual: failedFull.manual,
    lastResort: failedFull.lastResort,
    humanNetwork,
    detailHasNetwork,
    injectionError,
    carrierInHuman,
    pathConsistent,
    networkErrorSourceText: detailText.slice(0, 2000),
  })
  rec({ step: 'l2-04-detail-network-original', what: '失败说法与真实网络事实一致：人话格指向网络/数据源，注入层原始错误留 raw', expected: '人话格出现「网络/数据源/连接/ECONNREFUSED 类」措辞；注入层 ping 原始错误非空并写 raw', actual: JSON.stringify({ humanText, humanNetwork, injectionError, detailHasNetwork }), ok: (humanNetwork || detailHasNetwork) && injectionError !== null && injectionError !== '' })
  rec({ step: 'l2-05-exec-and-fail', what: '失败事件与「走到哪一步」自洽：gate 拒绝不跑 pnpm 不落 job；exec 失败跑过 pnpm 且非零退出、台账 failed', expected: 'check-failed → stage=gate reason=gate-refused exec=0 且台账无成功终态；install-failed → stage=exec exec≥1 全 false、台账 failed', actual: JSON.stringify({ errCode: failCode, failStage, failReason, failCodeLogged, execs: execs1.length, okExecs: okExecCount(execs1), ledgerState: ledgerStateOf(ledger1) }), ok: pathConsistent })
  rec({ step: 'l2-06-no-retry-storm', what: '失败后静置 8s 无自动重试（恰一次安装尝试）', expected: 'update.install.request/fail 各恰 1 条；exec 计数与失败路径一致；前后两次读日志计数不增长', actual: JSON.stringify({ countAtFail, countAtWindowEnd, liveCountsStable }), ok: noRetryOk })
  rec({ step: 'l2-07-no-false-success', what: '无假成功：磁盘仍基版、台账无成功终态、面板失败档', expected: '磁盘 A=0.0.1、台账 state 不是 completed/restart-required（gate 路径可为 missing，因为没打开 job）、横幅 kind=failed', actual: JSON.stringify({ disk: diskAfterFail, ledgerState: ledgerStateOf(ledger1), bannerKind: failBanner ? failBanner.kind : null }), ok: diskUnchanged && ledgerNoFalseSuccess && failBanner !== null && failBanner.kind !== 'done' })
  rec({ step: 'l2-08-no-carrier-in-human', what: '#267 诚实面：registry/网络类失败的人话格/台账 detail 不出现载体命令', expected: '横幅标题+副文案+台账 message 不匹配 dsh plugin --profile … add --save-exact …', actual: JSON.stringify({ carrierInHuman, humanText: humanText.slice(0, 700) }), ok: !carrierInHuman })

  // ---- 5. 同 storage/同端口重启 registry（外部恢复） ----
  const localOnlyPackages = [...DEFAULT_LOCAL_ONLY_PACKAGES, ...fixtureEnv.npmjsMirror.dependencies.map((dependency) => dependency.name)]
  const restarted = await startVerdaccio({ installDir: options.verdaccioInstallDir, runDir: ctx.run.layout.registryDir, port: registry.port, localOnlyPackages })
  ctx.restartedRegistry = restarted
  const pingAfterRestart = await pingRegistry(restarted.baseUrl)
  await ctx.run.raw('l2-registry-restart', {
    port: restarted.port,
    baseUrl: restarted.baseUrl,
    configPath: restarted.configPath,
    storageDir: restarted.storageDir,
    localOnlyPackages,
    ping: pingAfterRestart,
    samePortAsKilled: restarted.port === registry.port,
    stdoutTail: restarted.stdout().slice(-2000),
    stderrTail: restarted.stderr().slice(-2000),
  })
  rec({ step: 'l2-09-registry-restored', what: '同 storage/同端口重启本 run 私有 registry（外部恢复手段）', expected: '端口与杀前相同且 /-/ping 恢复 ok', actual: JSON.stringify({ samePort: restarted.port === registry.port, ping: { ok: pingAfterRestart.ok, status: pingAfterRestart.status } }), ok: restarted.port === registry.port && pingAfterRestart.ok })

  // ---- 6. 重试：检查仍列出 0.0.2 → 点安装 → 真装成 ----
  const gen2 = await startHostGen(ctx, 'l2-gen2')
  const ui2 = uiOf(gen2)
  await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'gen2 A 面板初始状态回填')
  const retryBanner = await readPanel(ui2, cardA, panelA)
  await clickInCard(ui2, cardA, panelA + ' button[data-action="check"]')
  const update2 = await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', '恢复后检查仍给出可更新')
  const update2Ok = update2.banner !== null && update2.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。'
  await capture(ctx.run, ui2, {
    step: 'l2-30-retry-check',
    what: 'registry 恢复后重启宿主：面板不再残留失败谎报，重新检查仍如实列出 0.0.2',
    expected: '重试前横幅为失败/已了结真相面；点检查后横幅原文「有新版本 0.0.2 可安装（当前版本 0.0.1）。」',
    actual: JSON.stringify({ before: retryBanner ? retryBanner.banner : null, check: update2.banner }),
    verdict: update2Ok ? 'pass' : 'fail',
  })
  rec({ step: 'l2-10-retry-check', what: '恢复后重新检查仍是可更新（不因上一轮失败而谎报最新）', expected: '可更新横幅原文精确匹配', actual: JSON.stringify({ beforeRetry: retryBanner ? retryBanner.banner : null, afterCheck: update2.banner }), ok: update2Ok })

  const retryClickAt = new Date().toISOString()
  await clickInCard(ui2, cardA, panelA + ' button[data-action="install"]')
  await waitDiskVersions(ctx, { [packageA]: FIXTURE_VARIANT_VERSION }, 'L2 恢复后真装到 0.0.2')
  // 装完读取器换代首屏诚实未知，真 UI 点检查更新后落定（见 helper 注释）。
  const settled = await settlePanelDoneAfterInstall(ui2, cardA, panelA, 'L2 恢复后安装')
  const ledger2 = await waitForLedger(ctx, packageA, ['completed', 'restart-required'], 'L2 恢复后台账成功终态', 60000)
  const diskAfterSuccess = await diskVersions(ctx, [packageA])
  const settledOk = settled.banner !== null && settled.banner.title === '已是最新，无需更新。'
  const successLedgerOk = isSuccessLedger(ledger2) && String(ledger2?.state['targetVersion'] || '') === FIXTURE_VARIANT_VERSION
  await capture(ctx.run, ui2, {
    step: 'l2-40-retry-success',
    what: '重试安装真装成 0.0.2：面板已了结、磁盘 0.0.2、台账成功终态',
    expected: '横幅「已是最新，无需更新。」、磁盘 A=0.0.2、台账 state∈{completed,restart-required} 且 target=0.0.2',
    actual: JSON.stringify({ banner: settled.banner, disk: diskAfterSuccess, ledger: ledger2 ? { state: ledgerStateOf(ledger2), targetVersion: ledger2.state['targetVersion'] } : null }),
    verdict: settledOk && successLedgerOk ? 'pass' : 'fail',
  })
  rec({ step: 'l2-11-retry-success', what: '恢复后重试真装成 0.0.2（不是假成功）', expected: '磁盘 A=0.0.2、台账成功终态且 target=0.0.2、面板已了结', actual: JSON.stringify({ disk: diskAfterSuccess, ledgerState: ledgerStateOf(ledger2), banner: settled.banner }), ok: diskAfterSuccess[packageA] === FIXTURE_VARIANT_VERSION && successLedgerOk && settledOk })

  // ---- 7. 停 gen2 后核对：恰一次成功、无重复成功记录、无第二次尝试 ----
  await stopHostGen(ctx, gen2, 'l2-after-success')
  const events2 = await readEvents(ctx)
  const failsAll = installFailsOf(events2, packageA)
  const requestsAll = installRequestsOf(events2, packageA)
  const ledgerJobs = await ledgerJobsOf(ctx, packageA)
  const beforeFiles = (await listFilesRecursive(join(ctx.homeDir, 'updates'))).filter((file) => file.endsWith('before.json'))
  const singleSuccessRecord = ledgerJobs.length === 1 && isSuccessLedger(ledgerJobs[0] as LedgerEntry)
  const attemptsOk = requestsAll.length === 2 && failsAll.length === 1
  await ctx.run.raw('l2-success-facts', {
    retryClickAt,
    requests: requestsAll.map(eventFactOf),
    fails: failsAll.map(eventFactOf),
    ledgerJobs: ledgerJobs.map((entry) => ({ file: entry.file, state: entry.state, mtimeMs: entry.mtimeMs })),
    beforeFiles,
    disk: diskAfterSuccess,
    note: '单包面板自更新成功时旧日志口会随插件宿主重载轮换（见组 K 结论），成功 exec 行可能缺失；成功事实以磁盘+台账为准',
  })
  rec({ step: 'l2-12-single-success-record', what: '补一次成功后台账只留一条成功终态（无重复成功记录）', expected: 'A 的 state.json 恰 1 份且 state∈{completed,restart-required}；before.json 恰 1 份', actual: JSON.stringify({ ledgerJobs: ledgerJobs.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry) })), beforeFiles }), ok: singleSuccessRecord && beforeFiles.length === 1 })
  rec({ step: 'l2-13-attempts', what: '两次 UI 安装尝试 = 2 条 request、1 条 fail（失败一次 + 成功一次），无额外自动重试', expected: 'update.install.request=2、update.install.fail=1（exec 行可能因自更新日志轮换缺失，不作硬断言）', actual: 'requests=' + String(requestsAll.length) + ' fails=' + String(failsAll.length) + ' execs=' + String(installExecsOf(events2, packageA).length), ok: attemptsOk })

  // ---- 8. 再重启：面板/磁盘/台账一致，无重复成功 ----
  const gen3 = await startHostGen(ctx, 'l2-gen3')
  const ui3 = uiOf(gen3)
  // #284 修后：新进程首屏必须先如实说版本未知，再真 UI 点检查更新，才允许出现「已是最新」。
  await assertRestartHonestUnknown(ctx, ui3, cardA, panelA, 'l2-14a', 'L2 第二次重启后 A 面板首屏')
  await clickCheckAndWaitKnown(ui3, cardA, panelA, 'L2 第二次重启后 A 检查更新')
  const done3 = await waitForPanel(ui3, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', '第二次重启后已了结', 180000)
  const tagsAfter = await readCardTags(ui3, cardA)
  const ledger3 = await ledgerFor(ctx, packageA)
  const jobs3 = await ledgerJobsOf(ctx, packageA)
  const done3Ok = done3.banner !== null && done3.banner.title === '已是最新，无需更新。'
  const tagsOk = tagsAfter.clientTag === tagsA.clientTag && tagsAfter.hostTag === tagsA.hostTag
  const ledgerStableOk = isSuccessLedger(ledger3) && jobs3.length === 1
  await capture(ctx.run, ui3, {
    step: 'l2-50-restart-settled',
    what: '第二次重启后：首屏先如实说版本未知（见 l2-14a），真 UI 检查更新后面板已了结、运行构建 v0.0.2、台账仍恰一条成功终态',
    expected: '横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2、A 的 state.json 恰 1 份且成功',
    actual: JSON.stringify({ banner: done3.banner, tags: tagsAfter, ledgerJobs: jobs3.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry) })) }),
    verdict: done3Ok && tagsOk && ledgerStableOk ? 'pass' : 'fail',
  })
  rec({ step: 'l2-14-restart-truthful', what: '重启后如实展示：已最新 0.0.2，不残留失败谎报、无重复成功记录', expected: '面板已了结、build tags=0.0.2、台账恰 1 份成功', actual: JSON.stringify({ banner: done3.banner, tags: tagsAfter, ledgerCount: jobs3.length, ledgerState: ledgerStateOf(ledger3) }), ok: done3Ok && tagsOk && ledgerStableOk })
}

/** 把事件列表压成 raw 数组。 */
function asFactList(events: readonly LogEventRecord[]): Record<string, unknown>[] {
  return events.map(eventFactOf)
}

/* ================= 组 L 共用外部手段 / 轮询 helpers（L1、L3、L4、L5 共用） ================= */

/** 外部命令结果（icacls / whoami / taskkill 等外部注入手段用；spawn 直起，不经 shell）。 */
interface ExeResult {
  readonly exe: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** 跑一个外部命令（ACL/taskkill 等外部注入手段）；超时强杀并如实标记。 */
function runExe(exe: string, args: readonly string[], timeoutMs = 60000): Promise<ExeResult> {
  return new Promise<ExeResult>((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (!child.stdout || !child.stderr) {
      reject(new Error('外部命令没有可读管道：' + exe))
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (chunk: Uint8Array) => {
      stdout += Buffer.from(chunk).toString('utf8')
    })
    child.stderr.on('data', (chunk: Uint8Array) => {
      stderr += Buffer.from(chunk).toString('utf8')
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code: number | null, signal: string | null) => {
      // 工具层 tsconfig 的 node 垫片只有 exit 事件；留 150ms 排空管道尾部再收口。
      setTimeout(() => {
        clearTimeout(timer)
        resolve({ exe, args, exitCode: code, signal: signal === null ? null : String(signal), stdout, stderr, timedOut })
      }, 150)
    })
  })
}

/** sha256（can-red 注入前后字节核验用）。 */
function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 面板读数压成时间线快照（L1 并发观测用）。 */
interface PanelBrief {
  kind: string | null
  title: string
  errCode: string | null
  actions: string[]
}
function panelBriefOf(state: PanelState | null): PanelBrief | null {
  if (!state || !state.present) return null
  return {
    kind: state.banner ? state.banner.kind : null,
    title: state.banner ? state.banner.title : '',
    errCode: state.errCode,
    actions: state.actions.map((action) => (action.action === null ? '' : action.action)),
  }
}

/** 横幅 kind（面板未挂载退化为 null）。 */
function bannerKindOf(state: PanelState | null): string | null {
  return state && state.banner ? state.banner.kind : null
}

/** 等面板条件成立；超时返回 null（用于「可能不出现」的中间态观测，不掩盖最终断言）。 */
async function waitPanelOrNull(ui: UiHandle, cardSelector: string, pluginSelector: string, predicate: (state: PanelState) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<PanelState | null> {
  try {
    return await waitForPanel(ui, cardSelector, pluginSelector, predicate, label, timeoutMs)
  } catch {
    return null
  }
}

/** 在限定时间内等磁盘到变体版本（返回是否到位，不抛）。 */
async function waitVariantWithin(ctx: LBoundaryContext, packageName: string, label: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const disk = await diskVersions(ctx, [packageName])
    if (disk[packageName] === FIXTURE_VARIANT_VERSION) return true
    await sleep(POLL_MS)
  }
  ctx.run.addNote('等磁盘超时（' + label + '）：' + packageName + ' 未到 ' + FIXTURE_VARIANT_VERSION)
  return false
}

/** 读 <home>/update-queue 下的锁/队列原文（L5 残留锁证据；文件可能不存在）。 */
async function readQueueFacts(homeDir: string): Promise<{ root: string; files: string[]; lock: string | null; queue: string | null }> {
  const root = join(homeDir, 'update-queue')
  if (!(await directoryExists(root))) return { root, files: [], lock: null, queue: null }
  const files = (await listFilesRecursive(root)).map((file) => file.split('\\').join('/')).sort()
  let lock: string | null = null
  let queue: string | null = null
  for (const relative of files) {
    const absolute = isAbsolute(relative) ? relative : join(root, relative)
    const text = await readFile(absolute, 'utf8').catch(() => null)
    if (text === null) continue
    if (relative.endsWith('global.lock')) lock = relative + '\n' + text.slice(0, 4000)
    if (relative.endsWith('queue.json')) queue = relative + '\n' + text.slice(0, 8000)
  }
  return { root, files, lock, queue }
}

/** 当前用户身份（icacls 注入要按 SID 授权；whoami 原文入 raw）。 */
interface IdentityFacts {
  user: string
  sid: string | null
  groups: string
}
async function identityFacts(): Promise<IdentityFacts> {
  const who = await runExe('whoami', ['/user'])
  const match = /(S-1-[0-9-]+)/.exec(who.stdout)
  const groups = await runExe('whoami', ['/groups'])
  return {
    user: who.stdout.trim(),
    sid: match ? match[1] ?? null : null,
    groups: (groups.stdout + groups.stderr).trim().slice(0, 4000),
  }
}

/** 同用户写探针：证明「写不进去」是外部 ACL 真生效（而不是猜）。 */
async function writeProbe(dir: string): Promise<{ ok: boolean; code: string | null; message: string | null }> {
  const probe = join(dir, '.l284-write-probe-' + String(Date.now()) + '.txt')
  try {
    await writeFile(probe, 'probe')
    await rm(probe, { force: true })
    return { ok: true, code: null, message: null }
  } catch (error) {
    const record = error as { code?: unknown; message?: unknown }
    return {
      ok: false,
      code: typeof record.code === 'string' ? record.code : null,
      message: typeof record.message === 'string' ? record.message : String(error),
    }
  }
}

/** icacls 原文（注入/恢复前后对照）。 */
async function aclTextOf(dir: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runExe('icacls', [dir])
  return { exitCode: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

/** 权限类原话检测（L3 失败 detail/台账 message 必须出现真实「写不进去」类错误，不是空泛未知错误）。 */
const PERMISSION_ERROR_TOKEN = /(EPERM|EACCES|access is denied|Access is denied|permission denied|权限不足|拒绝访问|无法写入|不能写入|操作被拒绝|being used by another process)/i

/** taskkill /T /F 只杀本 run 的 web 宿主进程树（外部手段），并把 PID/输出/残留锁原文入 raw。 */
async function killHostMidInstall(ctx: LBoundaryContext, gen: HostGen, label: string): Promise<{ pid: number; killedAt: string; taskkill: ExeResult }> {
  const pid = gen.host.pid()
  if (pid === undefined) throw new Error(label + '：宿主没有 pid，无法 taskkill')
  const killedAt = new Date().toISOString()
  const taskkill = await runExe('taskkill', ['/PID', String(pid), '/T', '/F'])
  const queueFiles = await readQueueFacts(ctx.homeDir)
  await ctx.run.raw('host-kill-' + label, {
    pid,
    killedAt,
    taskkill: { exitCode: taskkill.exitCode, stdout: taskkill.stdout, stderr: taskkill.stderr, timedOut: taskkill.timedOut },
    queueFiles,
    note: 'taskkill /T /F 只杀本 run 的 web 宿主进程树（外部手段，不动产品代码）；锁/队列文件原文即时快照',
  })
  if (gen.ui) {
    await gen.ui.close().catch(() => undefined)
    gen.ui = null
  }
  gen.stopped = true
  await gen.host.close().catch(() => undefined)
  if (ctx.host === gen.host) {
    ctx.host = null
    ctx.ui = null
  }
  return { pid, killedAt, taskkill }
}

/** 面板上若安装键可用就点；不可用返回 false（L5 诚实忙碌探测用）。 */
async function clickInstallIfPossible(ui: UiHandle, cardSelector: string, pluginSelector: string): Promise<boolean> {
  const state = await readPanel(ui, cardSelector, pluginSelector)
  if (!state || !state.present) return false
  const action = state.actions.find((item) => item.action === 'install')
  if (!action || action.disabled) return false
  await clickInCard(ui, cardSelector, pluginSelector + ' button[data-action="install"]')
  return true
}

/**
 * 用真 UI 把某包重试安装到变体版本（先检查再装；L1 用）。
 *
 * #284 修驱动缺陷：旧实现只看一眼当前状态——不可点就点 check 然后只等 kind==='update' 就盲点 install，
 * 也不验证宿主是否真的接单。后到者还在忙碌/排队窗口、或检查回填慢时，会点到 disabled 按钮然后空等磁盘，
 * 最后抛成场景异常（unknown），把真实产品行为掩成工具故障。现按真机语义分三步，任何一步 90s 内不成立
 * 就落 fail 断言再抛错（fail 不进 unknown：证据里能直接看到卡在哪一步）：
 *   1) 等面板给出可点的「安装」；不可点且不在飞就先点「检查更新」，再等它回填出可安装档；
 *   2) 点击后等宿主接单的原始事实：界面进入在飞/排队档，或日志出现该包的 update.install.request；
 *   3) 等磁盘到变体版本（90s），失败时把台账状态一并写进断言。
 */
async function ensureInstalledViaUi(ctx: LBoundaryContext, ui: UiHandle, cardSelector: string, panelSelector: string, packageName: string, label: string): Promise<void> {
  const rec = recorderFor(ctx.run)
  // ---- 1. 等可点的安装（必要时先检查更新） ----
  const clickDeadline = Date.now() + RETRY_VIA_UI_TIMEOUT_MS
  let lastKind: string | null = null
  let lastTitle = ''
  let clickedAt: string | null = null
  while (Date.now() < clickDeadline && clickedAt === null) {
    const state = await readPanel(ui, cardSelector, panelSelector)
    if (!state || !state.present) {
      await sleep(POLL_MS)
      continue
    }
    lastKind = state.banner ? state.banner.kind : null
    lastTitle = state.banner ? state.banner.title : ''
    const installAction = state.actions.find((item) => item.action === 'install')
    if (installAction && !installAction.disabled) {
      await clickInCard(ui, cardSelector, panelSelector + ' button[data-action="install"]')
      clickedAt = new Date().toISOString()
      break
    }
    const inFlight = lastKind !== null && (IN_FLIGHT_KINDS as readonly string[]).indexOf(lastKind) >= 0
    if (!inFlight) {
      const checkAction = state.actions.find((item) => item.action === 'check')
      if (checkAction && !checkAction.disabled) await clickInCard(ui, cardSelector, panelSelector + ' button[data-action="check"]')
    }
    await sleep(POLL_MS)
  }
  rec({
    step: 'l1-retry-ui-' + packageName + '-click',
    what: label + '：面板给出可点的安装按钮并在 90s 内点下',
    expected: 'install 按钮可用（不可用时先点检查更新、等检查回填）；点击成功',
    actual: JSON.stringify({ clickedAt, lastKind, lastTitle, timeoutMs: RETRY_VIA_UI_TIMEOUT_MS }),
    ok: clickedAt !== null,
  })
  if (clickedAt === null) throw new Error(label + '：90s 内面板没有给出可点的安装按钮（last kind=' + String(lastKind) + '）')
  // ---- 2. 宿主真的接单：在飞/排队档，或 update.install.request ----
  // 真机 185200：并发落败方此前的 queued 意图还在队列里（gate=update-busy），装成后第一次点击
  // 仍被挡；真机 185900：高频重点点不出结果——每次点击会把「自己上一份 waiting 意图」留给队列，
  // 产品按 stale（~30s）回收，8s 一次的点法永远重排到队尾（日志 position 恒为 4、abandoned 每
  // 8s 一条）。所以驱动按真实节奏：点一次后先等产品回收陈旧意图（35s 冷却），再点下一次；
  // 总窗口 210s。只等接单事实，不放宽任何诚实性断言。
  const acceptDeadline = Date.now() + 210000
  let acceptedKind: string | null = null
  let requestCount = 0
  let acceptAttempts = 0
  let lastClickAtMs = 0
  while (Date.now() < acceptDeadline) {
    const state = await readPanel(ui, cardSelector, panelSelector)
    acceptedKind = state && state.banner ? state.banner.kind : null
    const events = await readEvents(ctx).catch(() => [] as LogEventRecord[])
    requestCount = installRequestsOf(events, packageName).length
    const inFlight = acceptedKind !== null && (IN_FLIGHT_KINDS as readonly string[]).indexOf(acceptedKind) >= 0
    if (inFlight || requestCount > 0) break
    const installAction = state ? state.actions.find((item) => item.action === 'install') : undefined
    const retryable = acceptedKind !== null && ['update', 'idle', 'failed', 'blocked'].indexOf(acceptedKind) >= 0
    const cooldownMs = acceptAttempts === 0 ? 0 : 35000
    if (installAction !== undefined && !installAction.disabled && retryable && Date.now() - lastClickAtMs >= cooldownMs) {
      await clickInCard(ui, cardSelector, panelSelector + ' button[data-action="install"]')
      acceptAttempts += 1
      lastClickAtMs = Date.now()
      ctx.run.addNote(label + '：第 ' + acceptAttempts + ' 次点安装（此前未被接单，面板 ' + acceptedKind + '；距上次 ' + String(lastClickAtMs) + 'ms）')
    }
    await sleep(1000)
  }
  const accepted = requestCount > 0 || (acceptedKind !== null && (IN_FLIGHT_KINDS as readonly string[]).indexOf(acceptedKind) >= 0)
  rec({
    step: 'l1-retry-ui-' + packageName + '-accepted',
    what: label + '：点击后宿主真的接单（不是按钮没接线的空点）',
    expected: '90s 内面板进入在飞/排队档，或日志出现该包的 update.install.request（若此前被自己的陈旧排队意图挡住，产品回收后重试点击）',
    actual: JSON.stringify({ acceptedKind, requestCount, acceptAttempts }),
    ok: accepted,
  })
  if (!accepted) throw new Error(label + '：点击后 90s 内既没进入在飞/排队档，也没有 update.install.request')
  // ---- 3. 磁盘到位（90s；失败把台账写进断言） ----
  try {
    await waitForDiskVersions(
      { homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageNames: [packageName] },
      { [packageName]: FIXTURE_VARIANT_VERSION },
      { label: label + '：重试安装后磁盘到位', timeoutMs: RETRY_VIA_UI_TIMEOUT_MS },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const ledger = await ledgerFor(ctx, packageName).catch(() => null)
    rec({
      step: 'l1-retry-ui-' + packageName + '-disk',
      what: label + '：重试安装后磁盘到变体版本',
      expected: packageName + ' 磁盘版本=' + FIXTURE_VARIANT_VERSION,
      actual: JSON.stringify({ message, ledgerState: ledgerStateOf(ledger), ledgerMessage: ledgerMessageOf(ledger) }),
      ok: false,
    })
    throw error
  }
  ctx.run.addNote(label + '：重试安装已把 ' + packageName + ' 装到 ' + FIXTURE_VARIANT_VERSION)
}

/**
 * 重启/新进程后首屏诚实断言（#284 修后行为）：夹具面板 autoCheck:false，新进程没查过最新版前
 * 不得显示「已是最新」，必须先如实说「版本信息未知」。记一条断言；不诚实时直接抛，
 * 避免后续等「已是最新」的旧断言把问题拖成超时/unknown。
 */
async function assertRestartHonestUnknown(ctx: LBoundaryContext, ui: UiHandle, cardSelector: string, pluginSelector: string, idPrefix: string, what: string): Promise<PanelState> {
  const state = await waitForPanel(ui, cardSelector, pluginSelector, (next) => next.banner !== null && next.banner.kind !== 'loading', what + '：新进程首屏回填', 180000)
  const kind = state.banner ? state.banner.kind : null
  const title = state.banner ? state.banner.title : ''
  const honest = kind !== 'done' && title.indexOf('已是最新') < 0 && (kind === 'idle' || kind === 'unknown') && title.indexOf('版本信息未知') >= 0
  recorderFor(ctx.run)({
    step: idPrefix + '-restart-honest-unknown',
    what: what + '：新进程首屏没查过最新版时不得谎称已是最新',
    expected: '横幅 kind=idle/unknown、文案含「版本信息未知」、不含「已是最新」，并提供检查更新动作',
    actual: JSON.stringify(state.banner),
    ok: honest,
  })
  if (!honest) throw new Error(what + '：新进程首屏没有如实说版本信息未知（banner=' + JSON.stringify(state.banner) + '）')
  return state
}

/** 真 UI 点「检查更新」，等面板重新给出可判定的档（可更新或已最新），返回该状态。 */
async function clickCheckAndWaitKnown(ui: UiHandle, cardSelector: string, pluginSelector: string, what: string): Promise<PanelState> {
  await clickInCard(ui, cardSelector, pluginSelector + ' button[data-action="check"]')
  return waitForPanel(ui, cardSelector, pluginSelector, (next) => next.banner !== null && (next.banner.kind === 'update' || next.banner.kind === 'done'), what + '：检查更新后档位回填', 180000)
}

/**
 * 装完后让面板落到「已了结」：安装会改写磁盘包清单 → 读取器按 runningVersion 换代，新实例没查过
 * 最新版，首屏先给诚实「版本信息未知」（#284 修后行为，不是假话）。这是产品诚实行为，驱动只能
 * 真 UI 点检查更新让它自愈，再等 done；不通过等待旧状态来伪造「装完即已最新」。
 * 注意：装完最初几秒面板仍可能是 busy/restart（旧读取器结论 + 磁盘已换），此时 check 按钮不可点或
 * 点不出新结论，必须先等这一档过去（观察点：164500 run 里 busy 状态下点 check 无 update.panel.action）。
 * 首屏已是 done（同实例记忆还在）时直接用，不夺走证据。
 */
async function settlePanelDoneAfterInstall(ui: UiHandle, cardSelector: string, pluginSelector: string, what: string): Promise<PanelState> {
  const deadline = Date.now() + 180000
  let last: PanelState | null = null
  while (Date.now() < deadline) {
    last = await readPanel(ui, cardSelector, pluginSelector)
    const banner = last !== null && last.present ? last.banner : null
    if (banner !== null && banner.kind === 'done') return last as PanelState
    const transient = banner === null || banner.kind === 'loading' || banner.kind === 'busy' || banner.kind === 'restart'
    const check = last !== null ? last.actions.find((item) => item.action === 'check') : undefined
    if (!transient && check !== undefined && !check.disabled) {
      await clickInCard(ui, cardSelector, pluginSelector + ' button[data-action="check"]')
      // 点完等结论回填：done 直接收；其它可判定档回外层再决定是否再点。
      const attemptDeadline = Date.now() + 60000
      while (Date.now() < attemptDeadline) {
        const next = await readPanel(ui, cardSelector, pluginSelector)
        if (next !== null && next.present && next.banner !== null) {
          last = next
          if (next.banner.kind === 'done') return next
          if (next.banner.kind !== 'loading' && next.banner.kind !== 'busy') break
        }
        await sleep(POLL_MS)
      }
    }
    await sleep(POLL_MS)
  }
  throw new Error('等待面板落定超时（' + what + '）：last=' + JSON.stringify(last !== null ? last.banner : null))
}

/** L1：同一宿主进程里 A、B 两个集成方面板同一 tick 点安装 → 串行/忙碌诚实、exactly-once、重启后不回退。 */
async function runL1(ctx: LBoundaryContext, options: LBoundaryScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('L1 需要夹具环境（run.fixtureEnv 为空）')
  const packageA = FIXTURE_SLOT_A.packageName
  const packageB = FIXTURE_SLOT_B.packageName
  const cardA = cardSelectorOf('a')
  const panelA = '.dsh-upd[data-plugin="' + packageA + '"]'
  const cardB = cardSelectorOf('b')
  const panelB = '.dsh-upd[data-plugin="' + packageB + '"]'
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)
  const tagsB = fixtureBuildTagsOf(FIXTURE_SLOT_B, FIXTURE_VARIANT_VERSION)

  // ---- 1. 两个面板都检查到 0.0.2 ----
  const gen1 = await startHostGen(ctx, 'l1-gen1')
  const ui1 = uiOf(gen1)
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L1 A 面板初始状态回填')
  await waitForPanel(ui1, cardB, panelB, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L1 B 面板初始状态回填')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  const updateA = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', 'L1 A 检查给出可更新')
  await clickInCard(ui1, cardB, panelB + ' button[data-action="check"]')
  const updateB = await waitForPanel(ui1, cardB, panelB, (state) => state.banner !== null && state.banner.kind === 'update', 'L1 B 检查给出可更新')
  const updateAOk = updateA.banner !== null && updateA.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。'
  const updateBOk = updateB.banner !== null && updateB.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。'
  await capture(ctx.run, ui1, {
    step: 'l1-10-both-checked',
    what: '同一宿主进程内 A、B 两个单包面板都检查到 0.0.2 可更新（并发点安装前的对照）',
    expected: '两个面板横幅都精确等于「有新版本 0.0.2 可安装（当前版本 0.0.1）。」',
    actual: JSON.stringify({ a: updateA.banner, b: updateB.banner }),
    verdict: updateAOk && updateBOk ? 'pass' : 'fail',
  })
  rec({ step: 'l1-01-both-checked', what: '并发注入前两个目标都可安装', expected: 'A/B 可更新横幅原文精确匹配', actual: JSON.stringify({ a: updateA.banner, b: updateB.banner }), ok: updateAOk && updateBOk })

  // ---- 2. 同一 evaluate tick 点两个安装（同一宿主进程两插件并发） ----
  const clickBoth = '(function(){' +
    'function click(cardSel,panelSel){var card=document.querySelector(cardSel);if(!card)return false;var panel=card.querySelector(panelSel);if(!panel)return false;var el=panel.querySelector("button[data-action=install]");if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true}' +
    'return {a:click(' + JSON.stringify(cardA) + ',' + JSON.stringify(panelA) + '),b:click(' + JSON.stringify(cardB) + ',' + JSON.stringify(panelB) + ')}' +
    '})()'
  const clickResult = await ui1.page.evaluate<{ a: boolean; b: boolean }>(clickBoth)
  const raceStartAt = new Date().toISOString()
  ctx.run.addNote('L1 同一 evaluate tick 点击 A/B 安装：' + JSON.stringify(clickResult))

  // ---- 3. 观测并发窗口：面板时间线 + 磁盘 + 宿主侧日志计数 ----
  const raceTimeline: { at: string; a: PanelBrief | null; b: PanelBrief | null; disk: Record<string, string | null> }[] = []
  let raceDisk = await diskVersions(ctx, [packageA, packageB])
  const raceDeadline = Date.now() + 45000
  while (Date.now() < raceDeadline) {
    const [raceA, raceB] = await Promise.all([readPanel(ui1, cardA, panelA), readPanel(ui1, cardB, panelB)])
    raceDisk = await diskVersions(ctx, [packageA, packageB])
    raceTimeline.push({ at: new Date().toISOString(), a: panelBriefOf(raceA), b: panelBriefOf(raceB), disk: raceDisk })
    if (raceDisk[packageA] === FIXTURE_VARIANT_VERSION || raceDisk[packageB] === FIXTURE_VARIANT_VERSION) break
    await sleep(350)
  }
  await sleep(2500)
  {
    const [raceA, raceB] = await Promise.all([readPanel(ui1, cardA, panelA), readPanel(ui1, cardB, panelB)])
    raceDisk = await diskVersions(ctx, [packageA, packageB])
    raceTimeline.push({ at: new Date().toISOString(), a: panelBriefOf(raceA), b: panelBriefOf(raceB), disk: raceDisk })
  }
  const raceEvents = await readEvents(ctx)
  const raceExecsA = installExecsOf(raceEvents, packageA).length
  const raceExecsB = installExecsOf(raceEvents, packageB).length
  const raceFailsA = installFailsOf(raceEvents, packageA).length
  const raceFailsB = installFailsOf(raceEvents, packageB).length
  const raceQueue = eventsNamed(raceEvents, 'update.queue.transition')
  const raceLockAnomalies = eventsNamed(raceEvents, 'update.lock.anomaly')
  const lastSnapshot = raceTimeline[raceTimeline.length - 1]
  const raceDoneA = raceDisk[packageA] === FIXTURE_VARIANT_VERSION
  const raceDoneB = raceDisk[packageB] === FIXTURE_VARIANT_VERSION
  // #284 修驱动缺陷：这里原先写反（A 落了盘却把 B 记为 winner），导致「后到者诚实忙碌」判定对错面板。
  // winner 只能是「这一窗里真的落了盘」的那一个；两个都落定/都没落定则无可归因（null），由断言按诚实忙碌另行覆盖。
  const raceWinner = raceDoneA && !raceDoneB ? packageA : raceDoneB && !raceDoneA ? packageB : null
  const raceLooserBrief = lastSnapshot ? (raceWinner === packageA ? lastSnapshot.b : raceWinner === packageB ? lastSnapshot.a : null) : null
  const raceLooserKind = raceLooserBrief ? raceLooserBrief.kind : null
  const raceLooserTitle = raceLooserBrief ? raceLooserBrief.title : ''
  // #284 第二面（真机 180549 红点）修后的诚实档：latest 已知比运行版新、但这次检查结论已装不了
  // （canInstall=false，典型是别的插件安装改写了共享使用范围）→ 面板给 idle「有新版本 X，但当前无法安装；
  // 请重新检查更新后重试。」。旧忙碌/失败/排队/阻挡档仍算诚实；idle 只认「明确知道有新版」或
  // 「明确说版本信息未知」两种诚实说话，done 一律不诚实（磁盘未变）。
  const raceLooserKnownHonest =
    raceLooserKind !== null && ['failed', 'busy', 'queued', 'blocked', 'restart', 'error'].indexOf(raceLooserKind) >= 0
  const raceLooserIdleHonest =
    raceLooserKind === 'idle' && (raceLooserTitle.indexOf('有新版本') >= 0 || raceLooserTitle.indexOf('版本信息未知') >= 0)
  // 真机 184500：落败者 A 的 gate 拒绝已在日志落定（update.install.fail），但面板轮询 5s 未回填，观测窗
  // 结束时仍显示「有新版本 0.0.2 可安装」。这也是真话（A 磁盘确实还是 0.0.1、0.0.2 确实可装），
  // 只是没来得及变成忙碌/失败档；不能当假「已最新」。落败者磁盘已变（装成了）才不认这档。
  const raceLoserPackageName = raceWinner === packageA ? packageB : raceWinner === packageB ? packageA : null
  const raceLooserUpdateHonest =
    raceLoserPackageName !== null && raceLooserKind === 'update' && raceLooserTitle.indexOf('有新版本') >= 0 && raceDisk[raceLoserPackageName] === FIXTURE_BASE_VERSION
  const raceLoserHonest = raceWinner === null || raceLooserKnownHonest || raceLooserIdleHonest || raceLooserUpdateHonest
  const raceExecTotal = raceExecsA + raceExecsB
  const raceSerialized = raceExecTotal <= 1 || raceQueue.length > 0
  const raceOk = raceSerialized && raceLoserHonest && !(raceWinner !== null && raceLooserKind === 'done')
  await ctx.run.raw('l1-race-observations', {
    raceStartAt,
    clickResult,
    timelineTail: raceTimeline.slice(-40),
    raceStepMs: 350,
    raceExecs: { a: raceExecsA, b: raceExecsB },
    raceFails: { a: raceFailsA, b: raceFailsB },
    queueEvents: raceQueue.map(eventFactOf),
    lockAnomalies: raceLockAnomalies.map(eventFactOf),
    raceDisk,
    raceWinner,
    raceLooserKind,
    raceLoserHonest,
    raceSerialized,
    note: '同一 evaluate tick 点安装后 45s 内面板/磁盘时间线；日志计数为并发窗口结束后的宿主侧事实（dsh-log 有防抖，可能略滞后）',
  })
  await capture(ctx.run, ui1, {
    step: 'l1-20-race-observed',
    what: '同一宿主进程里两个面板几乎同时点安装后的现场：一个安装已落定/进行中，另一个诚实忙碌/失败（不谎称已更新）',
    expected: '并发窗口内恰一个安装真跑（或第二个进队列），后到者不得显示「已是最新」而磁盘未变；面板时间线与日志/磁盘一致',
    actual: JSON.stringify({ raceDisk, raceWinner, raceLooser: raceLooserBrief, raceExecTotal, raceSerialized, queueEvents: raceQueue.length, lockAnomalies: raceLockAnomalies.length }),
    verdict: raceOk ? 'pass' : 'fail',
  })
  rec({ step: 'l1-02-race-serialized-or-honest-busy', what: '同进程两插件并发安装：串行落定或后到者诚实忙碌（不谎称已更新）', expected: '并发窗口内 exec 总数<=1 或出现队列事件；后到者横幅为忙碌/失败/排队/阻挡档，或诚实 idle（明确说有新版但当前装不了/版本信息未知），或仍诚实显示「有新版本可安装」且其磁盘/台账未变（轮询未回填，非假最新）', actual: JSON.stringify({ raceExecTotal, raceSerialized, raceLooserKind, raceLooserTitle, raceLooserUpdateHonest, queueEvents: raceQueue.length, lockAnomalies: raceLockAnomalies.length }), ok: raceOk })
  rec({ step: 'l1-03-no-fake-latest-at-race', what: '并发现场无假最新：后到面板在自己磁盘未变时不得显示「已是最新」', expected: '后到者 kind!==done 且文案不含「已是最新」（其磁盘仍是 0.0.1；修后诚实档为「有新版本 X，但当前无法安装」）', actual: JSON.stringify({ raceDisk, raceWinner, raceLooserKind, raceLooserTitle }), ok: raceWinner === null || (raceLooserKind !== 'done' && raceLooserTitle.indexOf('已是最新') < 0) })

  // ---- 4. 后到者重试完成（或产品自动续跑） ----
  const diskAfterRace = await diskVersions(ctx, [packageA, packageB])
  if (diskAfterRace[packageA] !== FIXTURE_VARIANT_VERSION) await ensureInstalledViaUi(ctx, ui1, cardA, panelA, packageA, 'L1 后到者 A')
  if (diskAfterRace[packageB] !== FIXTURE_VARIANT_VERSION) await ensureInstalledViaUi(ctx, ui1, cardB, panelB, packageB, 'L1 后到者 B')
  await waitDiskVersions(ctx, { [packageA]: FIXTURE_VARIANT_VERSION, [packageB]: FIXTURE_VARIANT_VERSION }, 'L1 两包最终都到 0.0.2')
  // 装完读取器换代：首屏诚实说版本未知（见 helper 注释），真 UI 点检查更新后落定。
  const settledA = await settlePanelDoneAfterInstall(ui1, cardA, panelA, 'L1 A 面板')
  const settledB = await settlePanelDoneAfterInstall(ui1, cardB, panelB, 'L1 B 面板')
  const tagsFinal = { a: await readCardTags(ui1, cardA), b: await readCardTags(ui1, cardB) }
  const ledgerA = await waitForLedger(ctx, packageA, SUCCESS_STATES, 'L1 A 台账成功', 60000)
  const ledgerB = await waitForLedger(ctx, packageB, SUCCESS_STATES, 'L1 B 台账成功', 60000)
  await capture(ctx.run, ui1, {
    step: 'l1-25-both-settled',
    what: '后到者重试/自动续跑完成：A、B 两个面板都已了结，磁盘 0.0.2，台账各一条成功终态',
    expected: '装完首屏诚实未知（读取器换代）→ 真 UI 各点一次检查更新后两面板「已是最新，无需更新。」、磁盘 A/B=0.0.2、台账各一条成功终态且 target=0.0.2',
    actual: JSON.stringify({ bannerA: settledA.banner, bannerB: settledB.banner, tags: tagsFinal, ledgerA: ledgerStateOf(ledgerA), ledgerB: ledgerStateOf(ledgerB) }),
    verdict: settledA.banner !== null && settledB.banner !== null && settledA.banner.title === '已是最新，无需更新。' && settledB.banner.title === '已是最新，无需更新。' && isSuccessLedger(ledgerA) && isSuccessLedger(ledgerB) ? 'pass' : 'fail',
  })

  // ---- 5. 停 gen1 后统一收割：exactly-once / 无跨目标污染 / 各一条成功台账 ----
  await stopHostGen(ctx, gen1, 'l1-after-settle')
  const events1 = await readEvents(ctx)
  const jobsA = await ledgerJobsOf(ctx, packageA)
  const jobsB = await ledgerJobsOf(ctx, packageB)
  const successJobsA = jobsA.filter((entry) => isSuccessLedger(entry))
  const successJobsB = jobsB.filter((entry) => isSuccessLedger(entry))
  const beforeA = (await listFilesRecursive(join(ctx.homeDir, 'updates'))).filter((file) => file.endsWith('before.json') && isLedgerPathOf(file.split('\\').join('/'), packageA))
  const beforeB = (await listFilesRecursive(join(ctx.homeDir, 'updates'))).filter((file) => file.endsWith('before.json') && isLedgerPathOf(file.split('\\').join('/'), packageB))
  const targetA = jobsA.length > 0 ? String((jobsA[0] as LedgerEntry).state['targetVersion'] || '') : ''
  const targetB = jobsB.length > 0 ? String((jobsB[0] as LedgerEntry).state['targetVersion'] || '') : ''
  const exactlyOnce = successJobsA.length === 1 && successJobsB.length === 1 && beforeA.length === 1 && beforeB.length === 1
  const diskFinal = await diskVersions(ctx, [packageA, packageB])
  const failTotal = installFailsOf(events1, packageA).length + installFailsOf(events1, packageB).length
  const requestTotal = installRequestsOf(events1, packageA).length + installRequestsOf(events1, packageB).length
  await ctx.run.raw('l1-final-facts', {
    requests: { a: installRequestsOf(events1, packageA).map(eventFactOf), b: installRequestsOf(events1, packageB).map(eventFactOf) },
    fails: { a: installFailsOf(events1, packageA).map(eventFactOf), b: installFailsOf(events1, packageB).map(eventFactOf) },
    execs: { a: installExecsOf(events1, packageA).map(eventFactOf), b: installExecsOf(events1, packageB).map(eventFactOf) },
    ledgerJobs: { a: jobsA.map((entry) => ({ file: entry.file, state: entry.state, mtimeMs: entry.mtimeMs })), b: jobsB.map((entry) => ({ file: entry.file, state: entry.state, mtimeMs: entry.mtimeMs })) },
    beforeFiles: { a: beforeA, b: beforeB },
    disk: diskFinal,
    tags: tagsFinal,
    note: '两包各自一份 state.json（同一插件+profile 共槽，成功重试覆盖失败）；恰一条成功终态才算 exactly-once',
  })
  rec({ step: 'l1-04-each-one-success', what: '两包各恰一次成功、各一条成功台账、无重复成功记录、无跨目标污染', expected: 'A/B 各恰 1 份成功 state.json + 1 份 before.json；target 各为 0.0.2；磁盘各 0.0.2', actual: JSON.stringify({ jobsA: jobsA.length, successJobsA: successJobsA.length, targetA, jobsB: jobsB.length, successJobsB: successJobsB.length, targetB, beforeA: beforeA.length, beforeB: beforeB.length, disk: diskFinal }), ok: exactlyOnce && targetA === FIXTURE_VARIANT_VERSION && targetB === FIXTURE_VARIANT_VERSION })
  // 真机 190500：后到者按真实排队语义重试时，每次被公平门拒绝都会留一行诚实 update.install.fail
  // （code=update-busy / stage=gate），这不是失败谎报也不是重试风暴；只要失败行全是真实忙碌拒绝即可。
  const failEvents1 = [...installFailsOf(events1, packageA), ...installFailsOf(events1, packageB)]
  const failCodes1 = failEvents1.map((event) => String(event.fields['code'] || '') + '/' + String(event.fields['reason'] || ''))
  const failAllHonestBusy = failCodes1.every((code) => code.indexOf('update-busy') >= 0 || code.indexOf('gate-refused') >= 0)
  rec({ step: 'l1-05-attempts-and-tags', what: '并发窗口只产生必要尝试，无重试风暴与假失败；两包客户端构建都是 0.0.2（宿主侧旧构建等重启后换，见 l1-06）', expected: 'install.request 总数<=3（两包各首次 + 至多一次后到者重试）；失败行只允许真实忙碌拒绝（gate-refused/update-busy）；两包 clientTag=0.0.2', actual: JSON.stringify({ requestTotal, failTotal, failCodes1, tags: tagsFinal }), ok: requestTotal <= 3 && failTotal <= 3 && failAllHonestBusy && tagsFinal.a.clientTag === tagsA.clientTag && tagsFinal.b.clientTag === tagsB.clientTag })

  // ---- 6. 重启后不回退 ----
  const gen2 = await startHostGen(ctx, 'l1-gen2')
  const ui2 = uiOf(gen2)
  // #284 修后：夹具 autoCheck:false，新进程首屏必须先如实说「版本信息未知」；再真 UI 点检查更新，才允许出现「已是最新」。
  await assertRestartHonestUnknown(ctx, ui2, cardA, panelA, 'l1-06a', 'L1 重启后 A 面板首屏')
  await assertRestartHonestUnknown(ctx, ui2, cardB, panelB, 'l1-06b', 'L1 重启后 B 面板首屏')
  await clickCheckAndWaitKnown(ui2, cardA, panelA, 'L1 重启后 A 检查更新')
  await clickCheckAndWaitKnown(ui2, cardB, panelB, 'L1 重启后 B 检查更新')
  const doneA2 = await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', 'L1 重启后 A 已了结', 180000)
  const doneB2 = await waitForPanel(ui2, cardB, panelB, (state) => state.banner !== null && state.banner.kind === 'done', 'L1 重启后 B 已了结', 180000)
  const tagsRestart = { a: await readCardTags(ui2, cardA), b: await readCardTags(ui2, cardB) }
  const jobsA2 = await ledgerJobsOf(ctx, packageA)
  const jobsB2 = await ledgerJobsOf(ctx, packageB)
  const restartOk = doneA2.banner !== null && doneB2.banner !== null && doneA2.banner.title === '已是最新，无需更新。' && doneB2.banner.title === '已是最新，无需更新。' && tagsRestart.a.clientTag === tagsA.clientTag && tagsRestart.b.clientTag === tagsB.clientTag && jobsA2.filter((entry) => isSuccessLedger(entry)).length === 1 && jobsB2.filter((entry) => isSuccessLedger(entry)).length === 1
  await capture(ctx.run, ui2, {
    step: 'l1-30-restart-truthful',
    what: '重启宿主后：首屏先如实说「版本信息未知」（已由 l1-06a/b 断言），真 UI 点检查更新后 A/B 两面板均「已是最新」，运行构建 0.0.2，两包台账仍各恰一条成功终态',
    expected: '首屏不谎称已是最新；检查后两面板已了结、clientTag/hostTag=0.0.2、A/B 各恰 1 份成功 state.json',
    actual: JSON.stringify({ a: doneA2.banner, b: doneB2.banner, tags: tagsRestart, jobsA: jobsA2.length, jobsB: jobsB2.length }),
    verdict: restartOk ? 'pass' : 'fail',
  })
  rec({ step: 'l1-06-restart-truthful', what: '重启后真 UI 检查更新，不回退、不重复成功记录（首屏诚实性见 l1-06a/b）', expected: '两面板已了结、build tags=0.0.2、两包各 1 条成功台账', actual: JSON.stringify({ tags: tagsRestart, jobsA: jobsA2.map((entry) => ledgerStateOf(entry)), jobsB: jobsB2.map((entry) => ledgerStateOf(entry)) }), ok: restartOk })
}

/** L3：profile 的 node_modules 加拒绝写/删 ACE（外部手段）→ 安装失败诚实；恢复 ACL 后重试成功。 */
async function runL3(ctx: LBoundaryContext, options: LBoundaryScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('L3 需要夹具环境（run.fixtureEnv 为空）')
  const packageA = FIXTURE_SLOT_A.packageName
  const cardA = cardSelectorOf('a')
  const panelA = '.dsh-upd[data-plugin="' + packageA + '"]'
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)

  // ---- 1. 真 UI 检查到 0.0.2（失败注入前对照） ----
  const gen1 = await startHostGen(ctx, 'l3-gen1')
  const ui1 = uiOf(gen1)
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L3 A 面板初始状态回填')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  const update = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', 'L3 检查给出可更新')
  const updateOk = update.banner !== null && update.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。'
  await capture(ctx.run, ui1, {
    step: 'l3-10-check-before-inject',
    what: '权限注入前对照：真 UI 点检查后列出 0.0.2 可更新',
    expected: '可更新横幅原文精确匹配',
    actual: JSON.stringify(update.banner),
    verdict: updateOk ? 'pass' : 'fail',
  })
  rec({ step: 'l3-00-check-before-inject', what: '权限注入前检查更新可用（失败可归因性依赖这一格）', expected: '可更新横幅原文精确匹配', actual: JSON.stringify(update.banner), ok: updateOk })

  // ---- 2. 外部注入：icacls 拒绝写/删 profile 的 node_modules（不是产品改代码） ----
  const profilePackageDir = installedPluginDir({ homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageName: packageA })
  const nodeModulesDir = dirname(profilePackageDir)
  const identity = await identityFacts()
  if (identity.sid === null) throw new Error('whoami /user 未取到当前用户 SID，无法做 icacls 注入')
  const aclBefore = await aclTextOf(nodeModulesDir)
  // icacls 认字面 SID 时必须带 * 前缀（*S-1-5-...）；不带会去解析账户名 → exit 1332
  // ERROR_NONE_MAPPED、拒绝项一条都没加上（真机 191500 红点：probe 仍可写，安装照常成功）。
  const sidSpec = '*' + identity.sid
  // 只拒「写数据/加子目录」（WD/AD），不拒 W/D 全集：实测 (OI)(CI)(W) 或 (D) 会让
  // readFile/realpath 包目录 EPERM（Windows 打开句柄带写属性检查），产品会把包判成
  // invalid-installation、安装门 check-expired，根本走不到 pnpm 失败——那不是「安装被权限拒绝」。
  // (AD,WD) 下读包/读清单照常、mkdir/写文件 EPERM：install 会在创建 staging 目录时真失败，
  // 旧包树保持完好，产品走「exec 失败」而不是「包读坏」。
  const deny = await runExe('icacls', [nodeModulesDir, '/deny', sidSpec + ':(OI)(CI)(AD,WD)'])
  const aclAfter = await aclTextOf(nodeModulesDir)
  const probeDenied = await writeProbe(nodeModulesDir)
  // 读探针：注入只挡写，产品读包/读清单仍应成功（否则失败会走 invalid-installation，不是安装被拒）。
  const readProbe = await readFile(join(profilePackageDir, 'package.json'), 'utf8')
    .then((text) => ({ ok: true, bytes: text.length, code: null as string | null }))
    .catch((error: { code?: unknown }) => ({ ok: false, bytes: 0, code: typeof error?.code === 'string' ? error.code : null }))
  const denyEffective = deny.exitCode === 0 && probeDenied.ok === false && readProbe.ok && (probeDenied.code !== null || PERMISSION_ERROR_TOKEN.test(probeDenied.message || ''))
  await ctx.run.raw('l3-acl-inject', {
    profilePackageDir,
    nodeModulesDir,
    identity: { user: identity.user, sid: identity.sid, groups: identity.groups },
    aclBefore,
    denyCommand: deny,
    aclAfter,
    writeProbe: probeDenied,
    readProbe,
    effective: denyEffective,
    note: 'icacls /deny *SID:(OI)(CI)(AD,WD) 对本 run 隔离 profile 的 node_modules 拒绝写数据/加子目录（读不受影响，产品仍认包 0.0.1 完好）；同用户 raw 写探针证明真写不进去（外部注入，未改产品代码）',
  })
  await capture(ctx.run, ui1, {
    step: 'l3-15-acl-injected',
    what: 'icacls 注入后同用户写探针被拒（外部 ACL 真生效），页面仍是注入前状态',
    expected: 'icacls /deny exit=0；同用户 writeFile 探针 EPERM/EACCES（失败）、读包仍 OK，不是猜「应该会失败」',
    actual: JSON.stringify({ denyExit: deny.exitCode, probe: probeDenied, readProbe }),
    verdict: denyEffective ? 'pass' : 'fail',
  })
  rec({ step: 'l3-01-acl-injected', what: '外部注入生效：ACL 拒绝写/加子目录 + 同用户写探针真失败、读包仍成功（失败可归因于安装写，不是包读坏）', expected: 'deny exit=0、写探针 EPERM/EACCES、读 package.json ok', actual: JSON.stringify({ denyExit: deny.exitCode, probe: probeDenied, readProbe, aclTail: aclAfter.stdout.split(/\r?\n/).slice(-3) }), ok: denyEffective })
  if (!denyEffective) {
    // 注入没生效就别再点安装（否则产品会正常装成，失败面证据是假的）；先把 ACL 撤掉再报错。
    await runExe('icacls', [nodeModulesDir, '/remove:d', sidSpec])
    throw new Error('ACL 注入未生效（写探针仍成功）：denyExit=' + String(deny.exitCode) + ' probe=' + JSON.stringify(probeDenied))
  }

  // ---- 3. 真 UI 点安装 → 失败诚实 ----
  // 从注入到恢复包一层 try/finally：中途任何断言/等待抛错都要把 ACL 撤掉（证据契约要求清理）。
  let aclRestoreVerified = false
  try {
  const injectAt = new Date().toISOString()
  await clickInCard(ui1, cardA, panelA + ' button[data-action="install"]')
  const failed = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'failed', 'L3 权限不足时安装失败横幅', INSTALL_TIMEOUT_MS)
  await sleep(800)
  const failedFull = (await readPanel(ui1, cardA, panelA)) as PanelState
  const failBanner = failedFull.banner
  const failTitle = failBanner ? failBanner.title : ''
  const failSub = failBanner ? failBanner.sub : ''
  const failCode = failedFull.errCode
  const failBannerOk = failBanner !== null && failTitle.indexOf('更新失败') >= 0 && failCode !== null && failCode.length > 0
  await capture(ctx.run, ui1, {
    step: 'l3-20-failure-panel',
    what: 'ACL 拒绝写下真 UI 点安装：失败横幅（人话格）+ 错误码 + 手工备用区；无假成功',
    expected: '横幅 kind=failed、标题含「更新失败」、errCode 非空；不得呈现「已是最新」/更新成功',
    actual: JSON.stringify({ banner: failBanner, errCode: failCode, manual: failedFull.manual, lastResort: failedFull.lastResort }),
    verdict: failBannerOk ? 'pass' : 'fail',
  })

  // ---- 4. 停宿主后统一收割失败事实 ----
  await stopHostGen(ctx, gen1, 'l3-after-failure')
  const events1 = await readEvents(ctx)
  const execs1 = installExecsOf(events1, packageA)
  const fails1 = installFailsOf(events1, packageA)
  const requests1 = installRequestsOf(events1, packageA)
  const ledger1 = await waitForLedger(ctx, packageA, ['failed'], 'L3 权限失败后台账落 failed', 60000)
  const ledgerState = ledgerStateOf(ledger1)
  const ledgerMessage = ledgerMessageOf(ledger1)
  const diskAfterFail = await diskVersions(ctx, [packageA])
  const failStage = fails1.length === 1 ? String(fails1[0]?.fields['stage'] || '') : ''
  const failReason = fails1.length === 1 ? String(fails1[0]?.fields['reason'] || '') : ''
  const failCodeLogged = fails1.length === 1 ? String(fails1[0]?.fields['code'] || '') : ''
  const humanText = [failTitle, failSub, ledgerMessage].join(' | ')
  const permissionInHuman = PERMISSION_ERROR_TOKEN.test(humanText)
  const failDetailText = [failTitle, failSub, ledgerMessage, JSON.stringify(requests1.map(eventFactOf)), JSON.stringify(execs1.map(eventFactOf))].join(' | ')
  const diskUnchanged = diskAfterFail[packageA] === FIXTURE_BASE_VERSION
  const noFalseSuccess = !isSuccessLedger(ledger1) && failBanner !== null && failBanner.kind !== 'done'
  const stageHonest = failStage === 'exec' || failStage === 'verify'
  await ctx.run.raw('l3-failure-facts', {
    injectAt,
    execs: execs1.map(eventFactOf),
    fails: fails1.map(eventFactOf),
    requests: requests1.map(eventFactOf),
    ledger: ledger1 ? { file: ledger1.file, state: ledger1.state, mtimeMs: ledger1.mtimeMs } : null,
    disk: diskAfterFail,
    banner: failBanner,
    errCode: failCode,
    manual: failedFull.manual,
    humanText,
    permissionInHuman,
    failStage,
    failReason,
    failCodeLogged,
    failDetailText: failDetailText.slice(0, 3000),
  })
  rec({ step: 'l3-02-failure-honest', what: '权限不足的失败面诚实：失败横幅+错误码，台账 failed，stage=exec/verify', expected: 'kind=failed、标题含「更新失败」、errCode 非空、台账 state=failed、stage∈{exec,verify}', actual: JSON.stringify({ bannerKind: failBanner ? failBanner.kind : null, errCode: failCode, ledgerState, failStage, failReason, failCodeLogged }), ok: failBannerOk && ledgerState === 'failed' && stageHonest })
  rec({ step: 'l3-03-permission-original', what: '失败 detail 含真实权限错误原话（不是空泛未知错误）', expected: '台账 message 或人话格出现 EPERM/EACCES/access denied/权限类原话', actual: JSON.stringify({ permissionInHuman, humanText: humanText.slice(0, 1200) }), ok: permissionInHuman })
  rec({ step: 'l3-04-no-false-success-no-retry', what: '无假成功、无自动重试：磁盘仍基版、台账 failed、恰一次安装尝试', expected: '磁盘 A=0.0.1、台账非成功、exec 恰 1 且无 ok=true、request/fail 各恰 1', actual: JSON.stringify({ disk: diskAfterFail, ledgerState, execs: execs1.length, okExecs: okExecCount(execs1), requests: requests1.length, fails: fails1.length }), ok: diskUnchanged && noFalseSuccess && execs1.length === 1 && okExecCount(execs1) === 0 && requests1.length === 1 && fails1.length === 1 })

  // ---- 5. 恢复 ACL（并复核） ----
  const restore = await runExe('icacls', [nodeModulesDir, '/remove:d', sidSpec])
  const aclAfterRestore = await aclTextOf(nodeModulesDir)
  const probeRestored = await writeProbe(nodeModulesDir)
  const restoredOk = restore.exitCode === 0 && probeRestored.ok === true
  await ctx.run.raw('l3-acl-restore', { restoreCommand: restore, aclAfterRestore, writeProbe: probeRestored, restoredOk, note: 'icacls /remove:d 撤销拒绝项；同用户写探针恢复成功才允许重试' })
  rec({ step: 'l3-05-acl-restored', what: '恢复 ACL 并复核：拒绝项移除、同用户写探针恢复成功', expected: 'icacls /remove:d exit=0 且写探针 ok=true', actual: JSON.stringify({ restoreExit: restore.exitCode, probe: probeRestored, aclTail: aclAfterRestore.stdout.split(/\r?\n/).slice(-3) }), ok: restoredOk })
  aclRestoreVerified = restoredOk
  } finally {
    if (!aclRestoreVerified) {
      const emergency = await runExe('icacls', [nodeModulesDir, '/remove:d', sidSpec])
      await ctx.run.raw('l3-acl-emergency-restore', { restore: emergency, note: '注入后场景中途失败时的兜底撤 ACL；正常路径见 l3-acl-restore' })
    }
  }

  // ---- 6. 恢复后重试：真装成 0.0.2 ----
  const gen2 = await startHostGen(ctx, 'l3-gen2')
  const ui2 = uiOf(gen2)
  await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L3 gen2 A 面板初始回填')
  // 盘上失败任务保留失败横幅（#245 failure-settled 不成立：目标 0.0.2 并未装上）——诚实历史，不是更新中。
  const failedHistory = await readPanel(ui2, cardA, panelA)
  if (failedHistory === null) throw new Error('L3 gen2 面板读不到（failedHistory=null）')
  const failedHistoryOk = failedHistory.banner !== null && failedHistory.banner.kind === 'failed' && failedHistory.banner.title.indexOf('更新失败') >= 0
  await capture(ctx.run, ui2, {
    step: 'l3-30-restart-failure-honest',
    what: '失败后重启（ACL 已恢复、未重试）：新宿主首屏如实保留上次失败横幅，不谎称更新中/已最新',
    expected: '横幅 kind=failed、标题含「更新失败」；无更新中/已是最新字样',
    actual: JSON.stringify({ banner: failedHistory.banner, errCode: failedHistory.errCode }),
    verdict: failedHistoryOk ? 'pass' : 'fail',
  })
  rec({ step: 'l3-06a-failure-persisted', what: '失败后重启仍如实展示失败（不谎称更新中、不自动重试）', expected: 'kind=failed 且标题含「更新失败」', actual: JSON.stringify({ banner: failedHistory.banner }), ok: failedHistoryOk })
  await clickInCard(ui2, cardA, panelA + ' button[data-action="check"]')
  await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.actions.some((entry) => entry.action === 'install' && entry.disabled === false), 'L3 恢复后安装按钮可用（检查拿到新凭证）', 90000)
  await clickInCard(ui2, cardA, panelA + ' button[data-action="install"]')
  await waitDiskVersions(ctx, { [packageA]: FIXTURE_VARIANT_VERSION }, 'L3 恢复后真装到 0.0.2')
  // 装完读取器换代首屏诚实未知，真 UI 点检查更新后落定（见 helper 注释）。
  const settled = await settlePanelDoneAfterInstall(ui2, cardA, panelA, 'L3 恢复后安装')
  const ledger2 = await waitForLedger(ctx, packageA, SUCCESS_STATES, 'L3 恢复后台账成功终态', 60000)
  const diskAfterSuccess = await diskVersions(ctx, [packageA])
  const settledOk = settled.banner !== null && settled.banner.title === '已是最新，无需更新。'
  const successOk = isSuccessLedger(ledger2) && String(ledger2?.state['targetVersion'] || '') === FIXTURE_VARIANT_VERSION
  await capture(ctx.run, ui2, {
    step: 'l3-40-retry-success',
    what: 'ACL 恢复后重试安装真装成 0.0.2：面板已了结、磁盘 0.0.2、台账成功终态',
    expected: '横幅「已是最新，无需更新。」、磁盘 0.0.2、台账成功终态 target=0.0.2',
    actual: JSON.stringify({ banner: settled.banner, disk: diskAfterSuccess, ledger: ledger2 ? { state: ledgerStateOf(ledger2), targetVersion: ledger2.state['targetVersion'] } : null }),
    verdict: settledOk && successOk ? 'pass' : 'fail',
  })
  rec({ step: 'l3-06-retry-success', what: 'ACL 恢复后重试真装成（不是假成功）', expected: '磁盘 0.0.2、台账成功终态 target=0.0.2、面板已了结', actual: JSON.stringify({ disk: diskAfterSuccess, ledgerState: ledgerStateOf(ledger2), banner: settled.banner }), ok: diskAfterSuccess[packageA] === FIXTURE_VARIANT_VERSION && successOk })
  await stopHostGen(ctx, gen2, 'l3-after-success')
  const jobsAfter = await ledgerJobsOf(ctx, packageA)
  const beforeAfter = (await listFilesRecursive(join(ctx.homeDir, 'updates'))).filter((file) => file.endsWith('before.json') && isLedgerPathOf(file.split('\\').join('/'), packageA))
  const events2 = await readEvents(ctx)
  await ctx.run.raw('l3-success-facts', {
    requests: installRequestsOf(events2, packageA).map(eventFactOf),
    execs: installExecsOf(events2, packageA).map(eventFactOf),
    fails: installFailsOf(events2, packageA).map(eventFactOf),
    ledgerJobs: jobsAfter.map((entry) => ({ file: entry.file, state: entry.state, mtimeMs: entry.mtimeMs })),
    beforeFiles: beforeAfter,
    disk: await diskVersions(ctx, [packageA]),
    note: '同一插件+profile 台账共槽：失败记录被成功重试覆盖，最终恰一条成功终态',
  })
  const oneSuccess = jobsAfter.filter((entry) => isSuccessLedger(entry)).length === 1 && beforeAfter.length === 1
  rec({ step: 'l3-07-single-success-record', what: '重试成功后台账只留一条成功终态（旧失败记录被成功覆盖，不算重复成功）', expected: 'A 的 state.json 恰 1 份且成功、before.json 恰 1 份', actual: JSON.stringify({ ledgerJobs: jobsAfter.map((entry) => ledgerStateOf(entry)), beforeFiles: beforeAfter }), ok: oneSuccess })

  // ---- 7. 再重启：如实展示 ----
  const gen3 = await startHostGen(ctx, 'l3-gen3')
  const ui3 = uiOf(gen3)
  // #284 修后：新进程首屏必须先如实说版本未知，再真 UI 点检查更新，才允许出现「已是最新」。
  await assertRestartHonestUnknown(ctx, ui3, cardA, panelA, 'l3-08a', 'L3 重启后 A 面板首屏')
  await clickCheckAndWaitKnown(ui3, cardA, panelA, 'L3 重启后 A 检查更新')
  const done3 = await waitForPanel(ui3, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', 'L3 重启后已了结', 180000)
  const tags3 = await readCardTags(ui3, cardA)
  const jobs3 = await ledgerJobsOf(ctx, packageA)
  const restartOk = done3.banner !== null && done3.banner.title === '已是最新，无需更新。' && tags3.clientTag === tagsA.clientTag && tags3.hostTag === tagsA.hostTag && jobs3.filter((entry) => isSuccessLedger(entry)).length === 1
  await capture(ctx.run, ui3, {
    step: 'l3-50-restart-truthful',
    what: '重启后如实展示：首屏版本未知（见 l3-08a）→ 真 UI 检查更新后面板已了结、运行构建 0.0.2、台账仍恰一条成功终态',
    expected: '横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2、台账恰 1 份成功',
    actual: JSON.stringify({ banner: done3.banner, tags: tags3, ledgerJobs: jobs3.map((entry) => ledgerStateOf(entry)) }),
    verdict: restartOk ? 'pass' : 'fail',
  })
  rec({ step: 'l3-08-restart-truthful', what: '重启后不残留失败谎报、无重复成功记录', expected: '面板已了结、build tags=0.0.2、台账恰 1 份成功', actual: JSON.stringify({ banner: done3.banner, tags: tags3, ledgerCount: jobs3.length }), ok: restartOk })
}

/** L4：安装中关页面 → 宿主侧真相不被页面生命周期左右；重开/重启后一致、exactly-once。 */
async function runL4(ctx: LBoundaryContext, options: LBoundaryScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('L4 需要夹具环境（run.fixtureEnv 为空）')
  const packageA = FIXTURE_SLOT_A.packageName
  const cardA = cardSelectorOf('a')
  const panelA = '.dsh-upd[data-plugin="' + packageA + '"]'
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)

  // ---- 1. 慢 registry（pnpm 请求各挂 8s）：检查 → 点安装 ----
  const gen1 = await startHostGen(ctx, 'l4-gen1', { delayMs: 8000 })
  const ui1 = uiOf(gen1)
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L4 A 面板初始状态回填')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  const update = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', 'L4 检查给出可更新')
  const updateOk = update.banner !== null && update.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。'
  await capture(ctx.run, ui1, {
    step: 'l4-10-slow-window-check',
    what: '延迟代理拉长安装窗前的对照：真 UI 检查到 0.0.2 可更新（产品 check 不走 pnpm，不受延迟影响）',
    expected: '可更新横幅原文精确匹配',
    actual: JSON.stringify(update.banner),
    verdict: updateOk ? 'pass' : 'fail',
  })
  rec({ step: 'l4-01-check-before-close', what: '关页面前提：检查可用、安装窗被延迟代理拉长', expected: '可更新横幅原文精确匹配', actual: JSON.stringify(update.banner), ok: updateOk })

  await clickInCard(ui1, cardA, panelA + ' button[data-action="install"]')
  const busy = await waitPanelOrNull(ui1, cardA, panelA, (state) => state.banner !== null && (state.banner.kind === 'busy' || state.banner.kind === 'restart' || state.progress.length > 0), 'L4 安装进行中（关页面前确认在飞）', 30000)
  const busyObserved = busy !== null
  const beforeClose = await readPanel(ui1, cardA, panelA)
  await capture(ctx.run, ui1, {
    step: 'l4-20-busy-before-close',
    what: '真 UI 点安装后、关页面前的现场：安装正在宿主侧进行（进度/忙碌档），页面即将被关闭',
    expected: '观测到安装进行中（busy/进度非空）；页面仍未关闭',
    actual: JSON.stringify({ busyObserved, panel: beforeClose }),
    verdict: busyObserved ? 'pass' : 'fail',
  })
  rec({ step: 'l4-02-install-in-flight', what: '关页面前安装真的在飞（不是空窗关页面）', expected: '面板出现 busy/进度非空', actual: JSON.stringify({ busyObserved, banner: beforeClose ? beforeClose.banner : null, progress: beforeClose ? beforeClose.progress : null }), ok: busyObserved })

  // ---- 2. 安装进行中关闭页面（真 page.close + browser.close） ----
  const closedAt = new Date().toISOString()
  await ui1.close()
  gen1.ui = null
  ctx.ui = null
  await ctx.run.raw('l4-page-closed', {
    closedAt,
    busyObserved,
    bannerAtClose: beforeClose ? beforeClose.banner : null,
    progressAtClose: beforeClose ? beforeClose.progress : null,
    hostUrlMasked: gen1.host.url.replace(/token=[^&]+/, 'token=***'),
    note: '安装请求已交给宿主（电话已回、exec 在后台跑）后关闭页面；此后不再读页面，只用磁盘/台账/日志/registry 请求判定宿主侧真相',
  })

  // ---- 3. 不看页面：宿主侧继续完成（磁盘/台账轮询） ----
  const hostCompleted = await waitVariantWithin(ctx, packageA, 'L4 页面关闭后宿主侧装到 0.0.2', INSTALL_TIMEOUT_MS)
  const completedAt = new Date().toISOString()
  const ledgerClosed = await waitForLedger(ctx, packageA, SUCCESS_STATES, 'L4 页面关闭后台账成功', 60000)
  const diskClosed = await diskVersions(ctx, [packageA])
  const closedBeforeCompleted = Date.parse(closedAt) < Date.parse(completedAt)
  const proxyRequests = ctx.front.requests()
  await ctx.run.raw('l4-host-completion-while-page-closed', {
    closedAt,
    completedAt,
    closedBeforeCompleted,
    hostCompleted,
    disk: diskClosed,
    ledger: ledgerClosed ? { file: ledgerClosed.file, state: ledgerClosed.state, mtimeMs: ledgerClosed.mtimeMs } : null,
    delayedProxyRequests: proxyRequests.filter((item) => item.delayed).length,
    proxyRequests: proxyRequests.length,
    note: '关页面期间宿主侧真装成（磁盘+台账为真），完成时刻晚于关页面时刻',
  })
  rec({ step: 'l4-03-host-side-after-page-close', what: '页面关闭不影响宿主侧安装：磁盘/台账真到位，完成时刻晚于关闭时刻', expected: '磁盘 0.0.2、台账成功终态、closedBeforeCompleted=true', actual: JSON.stringify({ closedAt, completedAt, closedBeforeCompleted, disk: diskClosed, ledgerState: ledgerStateOf(ledgerClosed) }), ok: hostCompleted && closedBeforeCompleted && isSuccessLedger(ledgerClosed) })

  // ---- 4. 重开页面：与宿主侧真相一致 ----
  const ui2 = await openUi(gen1.host.url)
  gen1.ui = ui2
  ctx.ui = ui2
  // 关页面期间装成 → 重开页面是新面板实例、没查过最新版：首屏诚实未知，真 UI 点检查更新后落定。
  const reopened = await settlePanelDoneAfterInstall(ui2, cardA, panelA, 'L4 重开页面后')
  const tagsReopened = await readCardTags(ui2, cardA)
  const reopenedOk = reopened.banner !== null && reopened.banner.title === '已是最新，无需更新。' && tagsReopened.clientTag === tagsA.clientTag
  await capture(ctx.run, ui2, {
    step: 'l4-30-reopened-truthful',
    what: '关页面后重开：首屏先诚实说版本未知（新面板实例没查过最新版）→ 真 UI 点检查更新后面板已「已是最新」、运行构建 0.0.2，与宿主侧磁盘/台账真相一致',
    expected: '首屏诚实未知、检查更新后横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2',
    actual: JSON.stringify({ banner: reopened.banner, tags: tagsReopened }),
    verdict: reopenedOk ? 'pass' : 'fail',
  })
  rec({ step: 'l4-04-reopen-truthful', what: '重开页面与宿主侧真相一致：无永远更新中、无重复作业入口', expected: '面板已了结、build tags=0.0.2', actual: JSON.stringify({ banner: reopened.banner, tags: tagsReopened }), ok: reopenedOk })

  // ---- 5. 停 gen1 后统一收割：exactly-once ----
  await stopHostGen(ctx, gen1, 'l4-after-reopen')
  const events1 = await readEvents(ctx)
  const requests1 = installRequestsOf(events1, packageA)
  const fails1 = installFailsOf(events1, packageA)
  const execs1 = installExecsOf(events1, packageA)
  const jobs1 = await ledgerJobsOf(ctx, packageA)
  const before1 = (await listFilesRecursive(join(ctx.homeDir, 'updates'))).filter((file) => file.endsWith('before.json') && isLedgerPathOf(file.split('\\').join('/'), packageA))
  const execOkMaybeRotated = execs1.length === 0 || (execs1.length === 1 && okExecCount(execs1) === 1)
  const exactlyOnce = requests1.length === 1 && fails1.length === 0 && jobs1.filter((entry) => isSuccessLedger(entry)).length === 1 && before1.length === 1 && execOkMaybeRotated
  await ctx.run.raw('l4-final-facts', {
    requests: requests1.map(eventFactOf),
    fails: fails1.map(eventFactOf),
    execs: execs1.map(eventFactOf),
    ledgerJobs: jobs1.map((entry) => ({ file: entry.file, state: entry.state, mtimeMs: entry.mtimeMs })),
    beforeFiles: before1,
    execOkMaybeRotated,
    note: '页面关闭/重开期间不得产生第二次安装请求；单包自更新成功时旧日志口可能轮换导致 exec 行缺失，exactly-once 以 request+台账+磁盘为准',
  })
  rec({ step: 'l4-05-exactly-once', what: '关页面/重开期间 exactly-once：安装请求恰 1 次、无失败、台账恰一条成功', expected: 'install.request=1、install.fail=0、成功台账 1 份、before.json 1 份', actual: JSON.stringify({ requests: requests1.length, fails: fails1.length, execs: execs1.length, okExecs: okExecCount(execs1), successJobs: jobs1.filter((entry) => isSuccessLedger(entry)).length, beforeFiles: before1.length }), ok: exactlyOnce })

  // ---- 6. 重启宿主：仍一致 ----
  const gen2 = await startHostGen(ctx, 'l4-gen2')
  const ui3 = uiOf(gen2)
  // #284 修后：新进程首屏必须先如实说版本未知，再真 UI 点检查更新，才允许出现「已是最新」。
  await assertRestartHonestUnknown(ctx, ui3, cardA, panelA, 'l4-06a', 'L4 重启后 A 面板首屏')
  await clickCheckAndWaitKnown(ui3, cardA, panelA, 'L4 重启后 A 检查更新')
  const done3 = await waitForPanel(ui3, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', 'L4 重启后已了结', 180000)
  const tags3 = await readCardTags(ui3, cardA)
  const jobs3 = await ledgerJobsOf(ctx, packageA)
  const restartOk = done3.banner !== null && done3.banner.title === '已是最新，无需更新。' && tags3.clientTag === tagsA.clientTag && tags3.hostTag === tagsA.hostTag && jobs3.filter((entry) => isSuccessLedger(entry)).length === 1
  await capture(ctx.run, ui3, {
    step: 'l4-40-restart-truthful',
    what: '重启宿主后：首屏版本未知（见 l4-06a）→ 真 UI 检查更新后面板已了结、运行构建 0.0.2、台账仍恰一条成功终态',
    expected: '横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2、台账恰 1 份成功',
    actual: JSON.stringify({ banner: done3.banner, tags: tags3, ledgerJobs: jobs3.map((entry) => ledgerStateOf(entry)) }),
    verdict: restartOk ? 'pass' : 'fail',
  })
  rec({ step: 'l4-06-restart-truthful', what: '重启后仍一致、不回退、无重复成功记录', expected: '面板已了结、build tags=0.0.2、台账恰 1 份成功', actual: JSON.stringify({ banner: done3.banner, tags: tags3, ledgerCount: jobs3.length }), ok: restartOk })
}

/** L5b 第二套隔离 home（独立 osHome/profile；共用本 run 的 TLS front/registry，台账/日志/队列全独立）。 */
async function prepareSecondHome(ctx: LBoundaryContext, label: string): Promise<LBoundaryContext> {
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('第二套 home 需要夹具环境（run.fixtureEnv 为空）')
  const osHomeDir = join(ctx.run.layout.root, 'os-home-' + label)
  const homeDir = join(osHomeDir, '.dsh')
  await ensureDir(osHomeDir)
  await ensureDir(homeDir)
  createWebProfileInHome({ homeDir, profileName: PROFILE_NAME })
  await ctx.run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl: fixtureEnv.registry.baseUrl })
  const sutOk = await verifySutInstalled(ctx.run, { homeDir, profileName: PROFILE_NAME, packageName: fixtureEnv.sut.name })
  const next: LBoundaryContext = {
    run: ctx.run,
    mode: ctx.mode,
    homeDir,
    osHomeDir,
    profileName: PROFILE_NAME,
    registryUrl: ctx.registryUrl,
    front: ctx.front,
    gens: [],
    host: null,
    ui: null,
    restartedRegistry: null,
  }
  await ctx.run.raw('l5-second-home', {
    label,
    osHomeDir,
    homeDir,
    profileName: PROFILE_NAME,
    sutOk,
    registryUrl: ctx.registryUrl,
    note: '第二套 home 与主 home 完全隔离（process.env 的 pnpm store/cache 仍按 run 隔离）；TLS front 共用',
  })
  recorderFor(ctx.run)({ step: 'l5-second-home', what: 'L5b 第二套隔离 home 建好且 SUT 构建一致', expected: 'sutOk=true 且基版已装', actual: JSON.stringify({ homeDir, sutOk }), ok: sutOk })
  return next
}

/** L5：安装中杀本 run 宿主 → 重启后残留锁/中断态度诚实；短阈值格验证陈旧锁回收 + 恰一次成功。 */
async function runL5(ctx: LBoundaryContext, options: LBoundaryScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('L5 需要夹具环境（run.fixtureEnv 为空）')
  const packageA = FIXTURE_SLOT_A.packageName
  const cardA = cardSelectorOf('a')
  const panelA = '.dsh-upd[data-plugin="' + packageA + '"]'
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)

  // ================= L5a：默认阈值格（安装窗内 taskkill → 重启后如实展示） =================
  const gen1 = await startHostGen(ctx, 'l5a-gen1', { delayMs: 6000 })
  const ui1 = uiOf(gen1)
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L5a A 面板初始状态回填')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', 'L5a 检查给出可更新')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="install"]')
  const busy = await waitPanelOrNull(ui1, cardA, panelA, (state) => state.banner !== null && (state.banner.kind === 'busy' || state.banner.kind === 'restart' || state.progress.length > 0), 'L5a 安装进行中', 45000)
  const busyObserved = busy !== null
  const beforeKill = await readPanel(ui1, cardA, panelA)
  await capture(ctx.run, ui1, {
    step: 'l5a-10-in-flight-before-kill',
    what: '真 UI 点安装后安装正在进行（延迟代理拉长安装窗），即将 taskkill 本 run 宿主（外部手段，不改产品代码）',
    expected: '观测到 busy/进度非空；宿主 PID 可读',
    actual: JSON.stringify({ busyObserved, panel: beforeKill, pid: gen1.host.pid() ?? null }),
    verdict: busyObserved ? 'pass' : 'fail',
  })
  rec({ step: 'l5a-in-flight', what: 'taskkill 前安装确在飞（不是空窗杀宿主）', expected: '面板 busy/进度非空且宿主 PID>0', actual: JSON.stringify({ busyObserved, banner: beforeKill ? beforeKill.banner : null, progress: beforeKill ? beforeKill.progress : null, pid: gen1.host.pid() ?? null }), ok: busyObserved && typeof gen1.host.pid() === 'number' })
  await sleep(1200)
  const killAt = Date.now()
  const killed = await killHostMidInstall(ctx, gen1, 'l5a')
  const diskAfterKill = await diskVersions(ctx, [packageA])
  const ledgerAfterKill = await ledgerFor(ctx, packageA)
  const queueAfterKill = await readQueueFacts(ctx.homeDir)
  await ctx.run.raw('l5a-after-kill-facts', {
    killedAt: killed.killedAt,
    pid: killed.pid,
    taskkill: killed.taskkill,
    disk: diskAfterKill,
    ledgerState: ledgerStateOf(ledgerAfterKill),
    ledger: ledgerAfterKill ? { file: ledgerAfterKill.file, state: ledgerAfterKill.state, mtimeMs: ledgerAfterKill.mtimeMs } : null,
    queueFiles: queueAfterKill.files,
    lockTail: queueAfterKill.lock,
    queueTail: queueAfterKill.queue,
    note: '宿主进程树被 taskkill /T /F；安装既未完成也未落虚假成功，锁/队列原文留证',
  })
  rec({ step: 'l5-01-killed-during-install', what: '安装窗内杀掉整个宿主进程树：taskkill 成功、磁盘仍基版、台账非成功', expected: 'taskkill exit=0 且磁盘 A=0.0.1 且台账不为成功', actual: JSON.stringify({ pid: killed.pid, taskkillExit: killed.taskkill.exitCode, disk: diskAfterKill, ledgerState: ledgerStateOf(ledgerAfterKill) }), ok: killed.taskkill.exitCode === 0 && diskAfterKill[packageA] === FIXTURE_BASE_VERSION && !isSuccessLedger(ledgerAfterKill) })

  const gen2 = await startHostGen(ctx, 'l5a-gen2')
  const ui2 = uiOf(gen2)
  const restarted = await waitPanelOrNull(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L5a 重启后面板回填', 90000)
  const restartedFull = restarted ?? (await readPanel(ui2, cardA, panelA))
  const restartedLedger = await ledgerFor(ctx, packageA)
  const diskAfterRestart = await diskVersions(ctx, [packageA])
  const queueAfterRestart = await readQueueFacts(ctx.homeDir)
  const restartBanner = restartedFull !== null ? restartedFull.banner : null
  const restartTitle = restartBanner !== null ? restartBanner.title : ''
  const restartSub = restartBanner !== null ? restartBanner.sub : ''
  const falseLatest = /已是最新|更新成功|无需更新/.test(restartTitle + ' ' + restartSub)
  const noFalseDone = restartBanner !== null && restartBanner.kind !== 'done' && !falseLatest
  const ledgerNotSuccess = !isSuccessLedger(restartedLedger)
  const diskBase = diskAfterRestart[packageA] === FIXTURE_BASE_VERSION
  await ctx.run.raw('l5a-restart-facts', {
    killedAt: killed.killedAt,
    panel: restartedFull,
    disk: diskAfterRestart,
    ledger: restartedLedger ? { file: restartedLedger.file, state: restartedLedger.state, mtimeMs: restartedLedger.mtimeMs } : null,
    queueFiles: queueAfterRestart.files,
    lockTail: queueAfterRestart.lock,
    queueTail: queueAfterRestart.queue,
    falseLatest,
    note: '重启后只用真 UI/磁盘/台账判定；面板全文与残留锁原文均在此 raw',
  })
  await capture(ctx.run, ui2, {
    step: 'l5a-20-restart-after-kill',
    what: '被杀后重启：面板如实反映中断（不得谎称「已是最新」/完成），磁盘仍基版、台账非成功；残留锁考虑见 raw',
    expected: '横幅 kind≠done 且文案不含已最新/更新成功；磁盘 A=0.0.1；台账非成功',
    actual: JSON.stringify({ banner: restartBanner, errCode: restartedFull ? restartedFull.errCode : null, lastResort: restartedFull ? restartedFull.lastResort : null, manual: restartedFull ? restartedFull.manual : null, disk: diskAfterRestart, ledgerState: ledgerStateOf(restartedLedger), queueFiles: queueAfterRestart.files, lockTail: (queueAfterRestart.lock || '').slice(-600) }),
    verdict: noFalseDone && ledgerNotSuccess && diskBase ? 'pass' : 'fail',
  })
  rec({ step: 'l5-02-restart-truthful', what: '被杀重启后如实展示：不谎称「已是最新」/完成，台账非成功、磁盘仍基版', expected: '横幅 kind≠done 且文案不含已最新/成功；台账非成功；磁盘基版', actual: JSON.stringify({ bannerKind: restartBanner ? restartBanner.kind : null, title: restartTitle, sub: restartSub, errCode: restartedFull ? restartedFull.errCode : null, ledgerState: ledgerStateOf(restartedLedger), disk: diskAfterRestart }), ok: noFalseDone && ledgerNotSuccess && diskBase })
  const residual = queueAfterKill.files.length > 0 || queueAfterRestart.files.length > 0 || ledgerStateOf(restartedLedger) === 'interrupted'
  rec({ step: 'l5-03-residual-evidence', what: '残留锁/中断可审计：raw 留 lock/queue 原文与台账 state，且面板不伪装完成', expected: '杀时或重启后存在 queue/lock 文件，或台账为 interrupted；面板非 done', actual: JSON.stringify({ killQueueFiles: queueAfterKill.files, restartQueueFiles: queueAfterRestart.files, lockTail: (queueAfterKill.lock || '').slice(-400), ledgerState: ledgerStateOf(restartedLedger), bannerKind: restartBanner ? restartBanner.kind : null }), ok: residual && noFalseDone })
  await stopHostGen(ctx, gen2, 'l5a-after-restart')

  // ================= L5b：短阈值格（陈旧锁回收 + 恰一次成功 + 再重启一致） =================
  const SHORT_TIMEOUT_MS = 12000
  const ctx2 = await prepareSecondHome(ctx, 'l5b')
  try {
    const genB1 = await startHostGen(ctx2, 'l5b-gen1', { delayMs: 6000, extraEnv: { DSH_SELFTEST_INSTALL_TIMEOUT_MS: String(SHORT_TIMEOUT_MS) } })
    const uiB1 = uiOf(genB1)
    await waitForPanel(uiB1, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L5b A 面板初始状态回填')
    await clickInCard(uiB1, cardA, panelA + ' button[data-action="check"]')
    await waitForPanel(uiB1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', 'L5b 检查给出可更新')
    await clickInCard(uiB1, cardA, panelA + ' button[data-action="install"]')
    const busyB = await waitPanelOrNull(uiB1, cardA, panelA, (state) => state.banner !== null && (state.banner.kind === 'busy' || state.progress.length > 0), 'L5b 安装进行中', 45000)
    const beforeKillB = await readPanel(uiB1, cardA, panelA)
    await sleep(1200)
    const killedB = await killHostMidInstall(ctx2, genB1, 'l5b')
    await ctx.run.raw('l5b-kill-facts', {
      killedAt: killedB.killedAt,
      pid: killedB.pid,
      taskkill: killedB.taskkill,
      busyObserved: busyB !== null,
      panelBeforeKill: beforeKillB,
      installTimeoutEnvMs: SHORT_TIMEOUT_MS,
      note: '短阈值宿主（DSH_SELFTEST_INSTALL_TIMEOUT_MS=12000 由夹具读到后作为 installTimeoutMs，也是安装锁陈旧阈值）：杀在安装窗内',
    })
    rec({ step: 'l5b-killed-in-window', what: '短阈值宿主安装窗内被杀（杀前安装确在飞）', expected: 'busy/进度非空且 taskkill exit=0', actual: JSON.stringify({ busyObserved: busyB !== null, taskkillExit: killedB.taskkill.exitCode, panelBeforeKill: beforeKillB }), ok: busyB !== null && killedB.taskkill.exitCode === 0 })

    await sleep(SHORT_TIMEOUT_MS + 4000)
    const staleDisk = await diskVersions(ctx2, [packageA])
    const staleLedger = await ledgerFor(ctx2, packageA)
    const staleQueue = await readQueueFacts(ctx2.homeDir)
    const lockFile = staleQueue.files.find((file) => file.endsWith('global.lock')) ?? null
    let lockAgeMs: number | null = null
    if (lockFile !== null) {
      try {
        const lockStat = await stat(lockFile)
        lockAgeMs = Date.now() - lockStat.mtimeMs
      } catch {
        lockAgeMs = null
      }
    }
    const elapsedSinceKillMs = Date.now() - killAt
    await ctx.run.raw('l5b-stale-window', {
      shortThresholdMs: SHORT_TIMEOUT_MS,
      elapsedSinceKillMs,
      lockFile,
      lockAgeMs,
      queueFiles: staleQueue.files,
      lockTail: staleQueue.lock,
      queueTail: staleQueue.queue,
      disk: staleDisk,
      ledgerState: ledgerStateOf(staleLedger),
      ledger: staleLedger ? { file: staleLedger.file, state: staleLedger.state, mtimeMs: staleLedger.mtimeMs } : null,
      note: 'kill 后等待超过本 run 宿主安装锁陈旧阈值（12s），期间无宿主运行：磁盘未变、无假成功；锁文件与 age 作为陈旧证据',
    })
    const staleHonest = staleDisk[packageA] === FIXTURE_BASE_VERSION && !isSuccessLedger(staleLedger) && elapsedSinceKillMs >= SHORT_TIMEOUT_MS
    rec({ step: 'l5-04-stale-window', what: '短阈值下被杀安装留下的陈旧锁：过阈值后仍无假成功、磁盘未变（锁留待回收）', expected: '等 >12000ms 后磁盘 A=0.0.1、台账非成功；lock age 或 elapsed 超阈值', actual: JSON.stringify({ elapsedSinceKillMs, lockAgeMs, lockFile, disk: staleDisk, ledgerState: ledgerStateOf(staleLedger) }), ok: staleHonest })

    const genB2 = await startHostGen(ctx2, 'l5b-gen2', { extraEnv: { DSH_SELFTEST_INSTALL_TIMEOUT_MS: String(SHORT_TIMEOUT_MS) } })
    const uiB2 = uiOf(genB2)
    await waitForPanel(uiB2, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'L5b 重启后 A 面板回填')
    // 被杀重启后盘上任务仍是中断态：面板如实显示失败/中断历史（不是更新中、不是已最新）。
    const interruptedB = await readPanel(uiB2, cardA, panelA)
    if (interruptedB === null) throw new Error('L5b gen2 面板读不到（interruptedB=null）')
    const interruptedOkB = interruptedB.banner !== null && interruptedB.banner.kind === 'failed' && interruptedB.banner.title.indexOf('更新失败') >= 0
    await capture(ctx.run, uiB2, {
      step: 'l5b-25-restart-interrupted-honest',
      what: '短阈值格被杀重启后首屏：如实显示上次安装中断（failed/recovery-required），不谎称更新中/已最新',
      expected: '横幅 kind=failed、标题含「更新失败」',
      actual: JSON.stringify({ banner: interruptedB.banner, errCode: interruptedB.errCode }),
      verdict: interruptedOkB ? 'pass' : 'fail',
    })
    rec({ step: 'l5b-interrupted-honest', what: '被杀重启如实展示中断历史（不谎称更新中/已完成）', expected: 'kind=failed 且标题含「更新失败」', actual: JSON.stringify({ banner: interruptedB.banner, errCode: interruptedB.errCode }), ok: interruptedOkB })
    await clickInCard(uiB2, cardA, panelA + ' button[data-action="check"]')
    await waitForPanel(uiB2, cardA, panelA, (state) => state.banner !== null && state.actions.some((entry) => entry.action === 'install' && entry.disabled === false), 'L5b 重启后检查拿到凭证、安装按钮可用（重试）', 90000)
    await clickInCard(uiB2, cardA, panelA + ' button[data-action="install"]')
    await waitDiskVersions(ctx2, { [packageA]: FIXTURE_VARIANT_VERSION }, 'L5b 陈旧锁回收后真装到 0.0.2')
    // 装完读取器换代首屏诚实未知，真 UI 点检查更新后落定（见 helper 注释）。
    const settledB = await settlePanelDoneAfterInstall(uiB2, cardA, panelA, 'L5b 安装')
    const ledgerB = await waitForLedger(ctx2, packageA, SUCCESS_STATES, 'L5b 台账成功终态', 60000)
    const diskB = await diskVersions(ctx2, [packageA])
    const reclaimOk = diskB[packageA] === FIXTURE_VARIANT_VERSION && isSuccessLedger(ledgerB)
    await capture(ctx.run, uiB2, {
      step: 'l5b-30-recovered-success',
      what: '短阈值格：被杀后重启、陈旧锁由产品自行回收（全程未手工删锁/改文件）后重试安装真装成 0.0.2',
      expected: '面板已了结、磁盘 0.0.2、台账成功终态',
      actual: JSON.stringify({ banner: settledB.banner, disk: diskB, ledgerState: ledgerStateOf(ledgerB) }),
      verdict: reclaimOk ? 'pass' : 'fail',
    })
    rec({ step: 'l5-05-stale-lock-reclaimed', what: '陈旧锁被产品自行回收（未人工删锁）：重试真装成', expected: '重试成功：磁盘 0.0.2 + 台账成功终态，且全程未手工清理锁', actual: JSON.stringify({ disk: diskB, ledgerState: ledgerStateOf(ledgerB), banner: settledB.banner }), ok: reclaimOk })
    await stopHostGen(ctx2, genB2, 'l5b-after-success')
    const eventsB = await readEvents(ctx2)
    const reclaimEvents = eventsB.filter((event) => (event.event === 'update.queue.transition' && String(event.fields['phase'] || '') === 'reclaimed') || (event.event === 'update.lock.anomaly' && String(event.fields['kind'] || '') === 'stale-owner'))
    const jobsB = await ledgerJobsOf(ctx2, packageA)
    const beforeB = (await listFilesRecursive(join(ctx2.homeDir, 'updates'))).filter((file) => file.endsWith('before.json') && isLedgerPathOf(file.split('\\').join('/'), packageA))
    const requestsB = installRequestsOf(eventsB, packageA)
    const execsB = installExecsOf(eventsB, packageA)
    const successJobsB = jobsB.filter((entry) => isSuccessLedger(entry)).length
    const exactlyOnceB = successJobsB === 1 && beforeB.length === 1 && okExecCount(execsB) >= 1
    const diskFinalB = await diskVersions(ctx2, [packageA])
    await ctx.run.raw('l5b-facts', {
      reclaimEvents: reclaimEvents.map(eventFactOf),
      requests: requestsB.map(eventFactOf),
      execs: execsB.map(eventFactOf),
      fails: installFailsOf(eventsB, packageA).map(eventFactOf),
      successJobs: successJobsB,
      ledgerJobs: jobsB.map((entry) => ({ file: entry.file, state: entry.state, mtimeMs: entry.mtimeMs })),
      beforeFiles: beforeB,
      disk: diskFinalB,
      note: '陈旧锁回收证据（reclaimed/stale-owner 事件若有）+ 恰一次成功终态；被杀尝试不应产生 ok exec',
    })
    rec({ step: 'l5-06-exactly-once-success', what: '被杀后恢复只留一条成功终态、无重复成功记录（恰一次成功）', expected: '成功台账恰 1 份、before.json 恰 1 份、至少一次成功 exec、磁盘 0.0.2', actual: JSON.stringify({ successJobs: successJobsB, beforeFiles: beforeB.length, okExecs: okExecCount(execsB), requests: requestsB.length, disk: diskFinalB }), ok: exactlyOnceB })
    if (reclaimEvents.length === 0) ctx.run.addNote('L5b 未观测到 reclaimed/stale-owner 事件；以「未手工清锁却重试成功」为回收证据（见 raw l5b-facts / l5b-stale-window）')

    const genB3 = await startHostGen(ctx2, 'l5b-gen3', { extraEnv: { DSH_SELFTEST_INSTALL_TIMEOUT_MS: String(SHORT_TIMEOUT_MS) } })
    const uiB3 = uiOf(genB3)
    // #284 修后：新进程首屏必须先如实说版本未知，再真 UI 点检查更新，才允许出现「已是最新」。
    await assertRestartHonestUnknown(ctx2, uiB3, cardA, panelA, 'l5b-07a', 'L5b 再次重启后 A 面板首屏')
    await clickCheckAndWaitKnown(uiB3, cardA, panelA, 'L5b 再次重启后 A 检查更新')
    const doneB3 = await waitForPanel(uiB3, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', 'L5b 再次重启后已了结', 180000)
    const tagsB3 = await readCardTags(uiB3, cardA)
    const jobsB3 = await ledgerJobsOf(ctx2, packageA)
    const finalOk = doneB3.banner !== null && doneB3.banner.title === '已是最新，无需更新。' && tagsB3.clientTag === tagsA.clientTag && tagsB3.hostTag === tagsA.hostTag && jobsB3.filter((entry) => isSuccessLedger(entry)).length === 1
    await capture(ctx.run, uiB3, {
      step: 'l5b-40-restart-truthful',
      what: '恢复成功后再次重启：首屏版本未知（见 l5b-07a）→ 真 UI 检查更新后三面一致（面板已了结 / 运行构建 0.0.2 / 台账恰一条成功），无重复成功记录',
      expected: '横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2、台账恰 1 份成功',
      actual: JSON.stringify({ banner: doneB3.banner, tags: tagsB3, ledgerJobs: jobsB3.map((entry) => ledgerStateOf(entry)) }),
      verdict: finalOk ? 'pass' : 'fail',
    })
    rec({ step: 'l5-07-three-faces-consistent', what: '恢复成功后重启：UI/磁盘/台账三面一致、无重复成功记录', expected: '面板已了结、build tags 0.0.2、台账恰 1 份成功', actual: JSON.stringify({ banner: doneB3.banner, tags: tagsB3, successJobs: jobsB3.filter((entry) => isSuccessLedger(entry)).length, disk: await diskVersions(ctx2, [packageA]) }), ok: finalOk })
    await stopHostGen(ctx2, genB3, 'l5b-final')
  } finally {
    await cleanupContext(ctx2, { stopFront: false })
  }
}

/** can-red 注入的谎话：失败横幅谎称已是最新（用来证明 L2 诚实性断言真能变红）。 */
const CAN_RED_LIE = '已是最新，无需更新。（{code}）：{detail}。'

/** 把一段 JS 源码里某个 i18n 键的 zh 值替换成 replacement；找不到该键/值则返回 null。 */
function patchZhValueOf(source: string, key: string, replacement: string): { patched: string; oldValue: string } | null {
  const keyIndex = source.indexOf('"' + key + '"')
  if (keyIndex < 0) return null
  const zhIndex = source.indexOf('zh: "', keyIndex)
  if (zhIndex < 0) return null
  const valueStart = zhIndex + 'zh: "'.length
  let cursor = valueStart
  let valueEnd = -1
  while (cursor < source.length) {
    const ch = source[cursor]
    if (ch === '\\') {
      cursor += 2
      continue
    }
    if (ch === '"') {
      valueEnd = cursor
      break
    }
    cursor += 1
  }
  if (valueEnd < 0) return null
  const patched = source.slice(0, valueStart) + replacement + source.slice(valueEnd)
  return { patched, oldValue: source.slice(valueStart, valueEnd) }
}

/**
 * can-red：把本 run profile 里「面板实际会加载的失败横幅文案」改成谎话，再跑 L2 证明诚实性断言真会红。
 * 面板文案在夹具集成方的构建产物（lib/client.js 打包了产品面板 + 字典副本）里生效，SUT 的
 * dist/core/i18n/dictionary.js 也一并改（覆盖宿主侧/其它加载路径）；两个文件都只改本 run 私有副本，
 * 不改工作树源码，finally 逐字节恢复并核 sha256。
 */
async function runCanRed(ctx: LBoundaryContext, options: LBoundaryScenarioOptions): Promise<void> {
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('can-red 需要夹具环境（run.fixtureEnv 为空）')
  const sutDir = installedPluginDir({ homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageName: fixtureEnv.sut.name })
  const fixtureDir = installedPluginDir({ homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageName: FIXTURE_SLOT_A.packageName })
  const targets = [
    { id: 'fixture-client-bundle', path: join(fixtureDir, 'lib', 'client.js') },
    { id: 'sut-dictionary', path: join(sutDir, 'dist', 'core', 'i18n', 'dictionary.js') },
  ]
  const patchedFiles: { id: string; path: string; original: string; beforeSha: string; afterSha: string; oldValue: string }[] = []
  for (const target of targets) {
    const original = await readFile(target.path, 'utf8')
    const beforeSha = sha256Of(original)
    const result = patchZhValueOf(original, 'panel.banner.error.title', CAN_RED_LIE)
    if (result === null) throw new Error('can-red 注入失败：' + target.id + ' 里找不到 panel.banner.error.title 的 zh 值')
    const afterSha = sha256Of(result.patched)
    await writeFile(target.path, result.patched)
    const readBack = await readFile(target.path, 'utf8')
    if (readBack.indexOf(CAN_RED_LIE) < 0 || sha256Of(readBack) !== afterSha) throw new Error('can-red 注入失败：' + target.id + ' 写回后读不到谎话')
    patchedFiles.push({ id: target.id, path: target.path, original, beforeSha, afterSha, oldValue: result.oldValue })
  }
  const injectionEffective = patchedFiles.length === targets.length
  await ctx.run.raw('can-red-injection', {
    files: patchedFiles.map((file) => ({ id: file.id, path: file.path, beforeSha: file.beforeSha, afterSha: file.afterSha, oldValue: file.oldValue })),
    injectedValue: CAN_RED_LIE,
    injectionEffective,
    expectedRedAssertions: ['l2-03'],
    expectedExitCode: 1,
    note: '把失败横幅标题改成谎称「已是最新，无需更新」：改本 run profile 里夹具集成方打包产物（面板实际加载的文案）与 SUT 字典副本各一处，不改工作树源码/产品源码；finally 逐字节恢复并核 sha256',
  })
  recorderFor(ctx.run)({ step: 'can-red-injection', what: 'can-red 注入：面板失败横幅被改成谎称「已是最新，无需更新」', expected: '夹具 client.js 与 SUT dictionary.js 中 panel.banner.error.title 的 zh 值都被替换且可读回', actual: JSON.stringify({ files: patchedFiles.map((file) => ({ id: file.id, beforeSha: file.beforeSha, afterSha: file.afterSha, oldValue: file.oldValue })) }), ok: injectionEffective })
  if (!injectionEffective) throw new Error('can-red 注入未生效，拒绝继续（否则红点不可归因）')
  ctx.run.addNote('can-red：把失败横幅谎话「已是最新，无需更新」注入本 run 私有夹具 client.js + SUT dictionary.js；预期 l2-03 诚实性断言变红、run 退出码 1')
  try {
    await runL2(ctx, { ...options, mode: 'l2' })
  } finally {
    const restored: { id: string; path: string; restoredSha: string; beforeSha: string; ok: boolean }[] = []
    for (const file of patchedFiles) {
      await writeFile(file.path, file.original)
      const restoredSha = sha256Of(await readFile(file.path, 'utf8'))
      restored.push({ id: file.id, path: file.path, restoredSha, beforeSha: file.beforeSha, ok: restoredSha === file.beforeSha })
    }
    await ctx.run.raw('can-red-restore', { files: restored })
    ctx.run.addNote('can-red 注入已回滚：' + restored.map((item) => item.id + '=' + String(item.ok)).join('，'))
  }
}

/** 组 L 入口：开 run → 准备隔离环境 → 按 mode 跑 → 收尾并落 run.json；定稿 run 复制进仓库。 */
export async function runLBoundaryScenario(options: LBoundaryScenarioOptions): Promise<RunManifest> {
  const scenarioId = MODE_SCENARIO[options.mode]
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: 'dsh-web',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
    ticket: '284',
  })
  let ctx: LBoundaryContext | null = null
  try {
    ctx = await prepareRun(run, options)
    if (options.mode === 'l1') await runL1(ctx, options)
    else if (options.mode === 'l2') await runL2(ctx, options)
    else if (options.mode === 'l3') await runL3(ctx, options)
    else if (options.mode === 'l4') await runL4(ctx, options)
    else if (options.mode === 'l5') await runL5(ctx, options)
    else await runCanRed(ctx, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await run.raw('scenario-error', { mode: options.mode, message, stack: error instanceof Error ? error.stack : null })
    run.record({ step: 'scenario-error', what: '场景主流程按预期走完、不抛工具异常', expected: '无异常', actual: message, verdict: 'unknown' })
    run.addNote('场景抛异常：' + message)
  } finally {
    if (ctx) await cleanupContext(ctx)
  }
  const manifest = await run.close()
  if (options.syncEvidence !== false) await copyRunEvidence(run.layout, options.worktree)
  return manifest
}
