/**
 * selftest/real-machine/scenarios/known-red-recovery.ts —— #284 A 组：4 条 known-red 的等效宿主真机恢复。
 *
 * 背景：known-red.md 里有四条「本机没有那种宿主 / 状态」的缺口：
 *   - t3-267-exit-one：第三方 Desktop（desktopProfiles + desktopPnpm）本机没有；
 *   - t4-268-no-cancel-probe：没有「不给 cancelInstall 的宿主」可诱发超时无取消；
 *   - t8-272-panel-pending-restart-branch：没有能在「磁盘已新版、运行仍旧版」时读面板的宿主；
 *   - t8-272-i2-runtime-version-not-authoritative：运行版本权威性没在真宿主里点过。
 *
 * 本场景不拿「本机没有」当结论：用产品文档化入口 createMultiHostUpdate 的 deps.readerOverrides
 * （README.md:527/:564/:600 的集成方入口）把宿主能力注入成等效宿主 —— 产品仍走 src/host/environment.ts
 * 的真实路由、真实 executor、真实电话/面板，安装仍由本 run 的真 CLI（官方发行包里的 dsh plugin）落到
 * 真磁盘。唯一的替代点是「宿主侧那两个服务对象由夹具提供」，边界写进 run.json notes 与 raw。
 *
 * 四格：
 *   - f2  f2-exit-one-third-party-success：readerOverrides.environmentKind='desktop' +
 *         desktopProfiles/desktopPnpm → 路线 desktop-service → 真 CLI 安装 → 重启后运行代码真换版。
 *   - f3  f3-exit-one-third-party-failure：同一路线两种真实失败 ——
 *         (A) check 之后下架变体 tarball → pnpm 404/nonzero-exit（诚实面不出现载体命令）；
 *         (B) 宿主不给 terminate 且 runPlugin 永不 resolve → 超时无终止「可能仍在后台继续」。
 *   - g8  g8-desktop-manager-no-cancel-timeout：readerOverrides.environmentKind='desktop-manager' +
 *         pluginManager（故意没有 cancelInstall）→ 安装迟迟不 resolve → 超时失败但后台真的装上了。
 *   - i4  i4-pending-restart-panel-truth：已装更新后把包从 profile 在册摘掉 → 重启面板走
 *         「已写盘未登记」分支（待重启语义 + 不谎称加载）。
 *   - can-red：F2 流程 + stale-variant 故障注入（清单 0.0.2、构建仍是 0.0.1）：重启后
 *         「运行代码真的换版」断言真红，run verdict=fail、exit=1。
 *
 * 真机纪律：每 run 私有 DSH_HOME（os-home/.dsh）+ 私有 profile + 随机端口 + 仓库外 verdaccio +
 * 私有 pnpm store/cache；一次最多 2 个 web 宿主 + 1 个浏览器；读日志一律在停宿主之后。
 * 试错 run 传 --no-evidence-sync，证据只进 runtime 目录；定稿 run 才复制进仓库。
 */
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TlsRegistryFront } from '../../fixtures/release/tls-registry-front.ts'
import { startTlsRegistryFront } from '../../fixtures/release/tls-registry-front.ts'
import type { FixtureSlot } from '../../fixtures/identity/fixture-slots.ts'
import { fixtureBridgeRouteOf, fixtureBuildTagPhoneOf, fixtureBuildTagsOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import type { LocalRegistry } from '../../fixtures/release/local-registry.ts'
import type { ScenarioFaultInjection } from '../runtime/scenario-runner.ts'
import { baselineVersionOf, publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import type { LogEventRecord } from '../runtime/log-evidence.ts'
import { captureLogFiles, readLogEvents } from '../runtime/log-evidence.ts'
import { removePublishedTarball, restorePublishedTarball } from '../runtime/registry-faults.ts'
import type { RunManifest } from '../runtime/evidence.ts'
import { AUTH_REQUIRED_MARKER, loadPlaywright } from '../base-verify/web-ui.ts'
import type { PlaywrightPage } from '../base-verify/web-ui.ts'
import { startCliHost } from '../host/cli-host.ts'
import type { CliHostSession } from '../host/cli-host.ts'
import { createWebProfileInHome } from '../host/isolated-profile.ts'
import { DSH_PATHS } from '../host/dsh-cli.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'
import type { T3Run } from './t3-common.ts'
import { cardSelectorOf, copyRunEvidence } from './batch-helpers.ts'
import { ensureDir } from '../../tooling/fs-utils.ts'
import { sleep, waitFor } from '../../tooling/process.ts'
import { waitForPortFree } from '../../tooling/ports.ts'

/** 组 #284 的运行模式。 */
export type RecoveryMode = 'f2' | 'f3' | 'g8' | 'i4' | 'can-red'

/** 场景入参（与组 K/T5 同形，mode 决定走哪一格）。 */
export interface RecoveryOptions {
  /** 试错 run 传 false：不把证据包复制进仓库（定稿 run 才同步）。默认 true。 */
  syncEvidence?: boolean
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: RecoveryMode
}

/** mode → 场景声明 id（can-red 复用 F2 声明，用 run note/raw 标记注入）。 */
const MODE_SCENARIO: Record<RecoveryMode, string> = {
  f2: 'f2-exit-one-third-party-success',
  f3: 'f3-exit-one-third-party-failure',
  g8: 'g8-desktop-manager-no-cancel-timeout',
  i4: 'i4-pending-restart-panel-truth',
  'can-red': 'f2-exit-one-third-party-success',
}

/** 等效宿主的 web profile 名（≠ desktop；等效宿主里产品点名由 readerOverrides 给，不靠这个名字路由）。 */
const PROFILE_NAME = 't3eq'
/** UI 视口：高一点让卡片/面板一次入画。 */
const VIEWPORT = { width: 1280, height: 1500 }
/** 一次安装（含 pnpm 取包）的最长等待。 */
const INSTALL_TIMEOUT_MS = 300000
/** 面板状态轮询的最长等待。 */
const PANEL_TIMEOUT_MS = 120000
/** 轮询间隔。 */
const POLL_MS = 250
/** 产品侧安装时限（G8/F3-B 的「超时格」用 3s；等效宿主故意把结果再拖后）。 */
const SHORT_TIMEOUT_MS = 3000
/** 等效管理器故意拖延多久才真正跑 CLI（远大于产品时限）。 */
const MANAGER_DELAY_MS = 8000
/** 产品码恒定 install-failed 的失败四格之一。 */
const INSTALL_FAIL_CODE = 'install-failed'

/** 截图/断言判定四态。 */
type Verdict = 'pass' | 'fail' | 'known-red' | 'unknown'

/** 截图元数据。 */
interface ShotMeta {
  readonly step: string
  readonly what: string
  readonly expected: string
  readonly actual: string
  readonly verdict: Verdict
  readonly note?: string
}

/** 一次 UI 会话。 */
interface UiHandle {
  readonly page: PlaywrightPage
  readonly browser: { close(): Promise<void> }
  readonly label: string
  close(): Promise<void>
}

/** 等效宿主种类（= 夹具模板里的 DSH_SELFTEST_EQUIVALENT_HOST.kind）。 */
type EquivalentKind = 'desktop' | 'desktop-manager' | 'reader-version'

/** 本次 run 的上下文。 */
interface Ctx {
  readonly run: T3Run
  readonly mode: RecoveryMode
  readonly homeDir: string
  readonly osHomeDir: string
  readonly profileName: string
  readonly registryUrl: string
  readonly upstreamRegistryUrl: string
  readonly registry: LocalRegistry
  readonly front: TlsRegistryFront
  readonly slot: FixtureSlot
  readonly packageName: string
  readonly route: string
  readonly phonePrefix: string
  readonly checkPhone: string
  readonly installPhone: string
  readonly statusPhone: string
  readonly buildTagPhone: string
  readonly baseVersion: string
  readonly variantVersion: string
  readonly baseline: PublishedFixture
  readonly variant: PublishedFixture
  hosts: HostHandle[]
}

/** 一个已起的宿主。 */
interface HostHandle {
  readonly index: number
  readonly label: string
  readonly kind: EquivalentKind | 'plain'
  readonly host: CliHostSession
  ui: UiHandle | null
  readonly profileDir: string
  readonly specPath: string
  stopped: boolean
}

/** 安装作业终态。 */
const TERMINAL_JOB_STATES = ['completed', 'restart-required', 'failed', 'interrupted'] as const

/** 产品安装超时的诚实文案（src/core/executor.ts:47-48 / :91-92 原文）。 */
const SERVICE_TIMEOUT_NO_TERMINATE_DETAIL = '安装超时；宿主未提供终止能力，这次安装可能仍在后台继续'
const MANAGER_TIMEOUT_NO_CANCEL_DETAIL = '安装超时；宿主未提供取消能力，这次安装可能仍在后台继续'

/** 单包卡片面板读数（一次页面求值；不拼多次快照）。 */
interface CardState {
  readonly present: boolean
  readonly text: string
  readonly banner: { kind: string | null; title: string; sub: string; action: string } | null
  readonly seal: string
  readonly manualCode: string | null
  readonly manualHeading: string
  readonly install: {
    readonly present: boolean
    readonly kind: string | null
    readonly status: string
    readonly sub: string
    readonly manualSummary: string
    readonly buttons: { action: string | null; text: string; disabled: boolean }[]
  } | null
}

/** 产品日志里的 exec/fail 观测。 */
interface InstallLogFacts {
  readonly execs: LogEventRecord[]
  readonly fails: LogEventRecord[]
  readonly requests: LogEventRecord[]
}

/** 截图（recorder.shot 写 shots/<id>.png + sidecar 进 run.json）。 */
async function capture(run: T3Run, ui: UiHandle, meta: ShotMeta): Promise<void> {
  const tmpPath = join(run.layout.rawDir, 'ui-shot-' + String(Date.now()) + '.png')
  await ui.page.screenshot({ path: tmpPath })
  const png = new Uint8Array(await readFile(tmpPath))
  await rm(tmpPath, { force: true })
  await run.recorder.shot('shot', png, meta)
}

/** 卡片面板读数脚本。 */
function cardScript(cardSelector: string, pluginSelector: string): string {
  return '(function(){' +
    'var card=document.querySelector(' + JSON.stringify(cardSelector) + ');' +
    'if(!card)return {present:false,text:"",banner:null,seal:"",manualCode:null,manualHeading:"",install:null};' +
    'function txt(el){return el?String(el.textContent||"").trim():""}' +
    'function q(s){return card.querySelector(s)}' +
    'var root=card.querySelector(' + JSON.stringify(pluginSelector) + ')||card;' +
    'var b=root.querySelector(".dsh-upd-banner");' +
    'var m=root.querySelector(".dsh-upd-manual");' +
    'var ib=card.querySelector(".dsh-upd-ib");' +
    'var st=ib?ib.querySelector(".dsh-upd-ib-status"):null;' +
    'var kind=null;' +
    'if(st){var matched=/(?:^|\s)dsh-upd-ib-kind-([a-z-]+)/.exec(st.className);kind=matched?matched[1]:null}' +
    'return {present:true,' +
      'text:txt(card),' +
      'banner:b?{kind:b.getAttribute("data-kind"),title:txt(b.querySelector("strong")||b),sub:txt(root.querySelector(".dsh-upd-banner-sub")),action:txt(b.querySelector("button"))}:null,' +
      'seal:txt(root.querySelector(".dsh-upd-seal")),' +
      'manualCode:m?txt(m.querySelector("code"))||null:null,' +
      'manualHeading:m?txt(m.querySelector("div")):"",' +
      'install:ib?{present:true,kind:kind,status:txt(st),sub:txt(ib.querySelector(".dsh-upd-ib-sub")),manualSummary:txt(ib.querySelector(".dsh-upd-ib-manual summary")),buttons:Array.prototype.slice.call(ib.querySelectorAll("button")).map(function(el){return {action:el.getAttribute("data-action"),text:txt(el),disabled:el.disabled===true||el.hasAttribute("disabled")}})}:null' +
    '};' +
    '})()'
}

/** 读卡片面板。 */
async function readCard(ui: UiHandle, slot: FixtureSlot): Promise<CardState> {
  return ui.page.evaluate<CardState>(cardScript(cardSelectorOf(slot.key), '.dsh-upd[data-plugin]'))
}

/** 在卡片内按 selector 点击（滚动到可视区后 click）。 */
async function clickInCard(ui: UiHandle, cardSelector: string, selector: string): Promise<void> {
  const clicked = await ui.page.evaluate<boolean>('(function(){var card=document.querySelector(' + JSON.stringify(cardSelector) + ');if(!card)return false;var el=card.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true})()')
  if (!clicked) throw new Error('点击失败（卡片内找不到）：' + cardSelector + ' ' + selector)
}

/** 调夹具暴露的 refresh 钩子（安装按钮/入口件只在任务期自轮询）。 */
async function refreshFixtureButton(ui: UiHandle): Promise<void> {
  await ui.page.evaluate<unknown>('(function(){var r=globalThis.__fixtureRefresh;if(!r||typeof r["button"]!=="function")return null;try{return r["button"]()}catch(e){return null}})()')
}

/** 等卡片里出现指定 action 的按钮（每轮 refresh 安装按钮）。 */
async function waitForCardAction(ui: UiHandle, slot: FixtureSlot, action: string, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<CardState> {
  const deadline = Date.now() + timeoutMs
  let last: CardState | null = null
  while (Date.now() < deadline) {
    await refreshFixtureButton(ui)
    last = await readCard(ui, slot)
    const buttons = last && last.install ? last.install.buttons : []
    if (buttons.some((button) => button.action === action)) return last as CardState
    await sleep(POLL_MS)
  }
  throw new Error('等待按钮超时（' + label + ' action=' + action + '）：last=' + JSON.stringify(last))
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
  // 首启弹窗「预览版说明」：只点精确文案「继续」的按钮，最多 5 秒。
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

/** 发一条夹具电话并解析成结构化结果。 */
async function callPhone(host: CliHostSession, route: string, phone: string, args: Record<string, unknown> = {}): Promise<{
  readonly reply: { status: number; body: any; durationMs: number }
  readonly ok: boolean
  readonly error: string | null
  readonly fields: Record<string, unknown>
  readonly snapshot: Record<string, any> | null
}> {
  const reply = await host.postPhone(route, phone, args)
  const body = reply.body && typeof reply.body === 'object' ? (reply.body as Record<string, unknown>) : {}
  const fields = body['reply'] && typeof body['reply'] === 'object' ? (body['reply'] as Record<string, unknown>) : {}
  const snapshotRaw = fields['snapshot']
  const snapshot = snapshotRaw && typeof snapshotRaw === 'object' ? (snapshotRaw as Record<string, any>) : null
  return { reply, ok: body['ok'] === true, error: typeof body['error'] === 'string' ? (body['error'] as string) : null, fields, snapshot }
}

/** 作业是否终态。 */
function isTerminalJob(state: unknown): boolean {
  return typeof state === 'string' && (TERMINAL_JOB_STATES as readonly string[]).indexOf(state) >= 0
}

/** 轮询 updateStatus 到终态。 */
async function waitForTerminalJob(host: CliHostSession, route: string, statusPhone: string, timeoutMs: number): Promise<{
  readonly outcome: Awaited<ReturnType<typeof callPhone>>
  readonly polls: number
  readonly elapsedMs: number
}> {
  const startedAt = Date.now()
  let polls = 0
  let last: Awaited<ReturnType<typeof callPhone>> | null = null
  await waitFor(
    '更新作业终态（updateStatus 轮询）',
    async () => {
      polls += 1
      last = await callPhone(host, route, statusPhone, {})
      const job = last.snapshot ? last.snapshot['job'] : null
      return isTerminalJob(job ? (job as Record<string, unknown>)['state'] : null) ? last : null
    },
    { timeoutMs, intervalMs: 1000 },
  )
  if (!last) throw new Error('等作业终态失败：没有任何回包')
  return { outcome: last, polls, elapsedMs: Date.now() - startedAt }
}

/** 把一次终态回包里的作业事实摘出来。 */
function jobFacts(outcome: Awaited<ReturnType<typeof callPhone>>): Record<string, unknown> {
  const jobRaw = outcome.snapshot ? outcome.snapshot['job'] : null
  return jobRaw && typeof jobRaw === 'object' ? (jobRaw as Record<string, unknown>) : {}
}

/** 作业里的产品码（可能嵌在 error 对象里）。 */
function jobCodeOf(job: Record<string, unknown>): string | null {
  const direct = job['code']
  if (typeof direct === 'string') return direct
  const error = job['error']
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>)['code'] === 'string') {
    return (error as Record<string, unknown>)['code'] as string
  }
  // 出口一/出口三的作业载荷把产品码嵌在 message 前缀（如 'install-failed: …'），job.code 常为空。
  const message = job['message']
  if (typeof message === 'string') {
    const matched = /^([a-z][a-z0-9-]*):\s/.exec(message)
    if (matched) return matched[1] as string
  }
  return null
}

/** 作业里给用户看的人话（message/detail）。 */
function jobMessageOf(job: Record<string, unknown>): string {
  const message = job['message']
  const detail = job['detail']
  const parts: string[] = []
  if (typeof message === 'string') parts.push(message)
  if (typeof detail === 'string' && detail && detail !== message) parts.push(detail)
  const error = job['error']
  if (error && typeof error === 'object') {
    const rec = error as Record<string, unknown>
    if (typeof rec['detail'] === 'string' && parts.indexOf(rec['detail']) < 0) parts.push(rec['detail'])
    if (typeof rec['message'] === 'string' && parts.length === 0) parts.push(rec['message'])
  }
  return parts.join('\n')
}

/** 发布记录 → '包名@版本' 摘要。 */
function specOf(published: PublishedFixture): string {
  return published.plan.packageName + '@' + published.plan.version
}

/** 造/准备 run 的隔离环境：profile、pnpm store、SUT 校验、基版磁盘核对、变体发布。 */
async function prepareRun(run: T3Run, options: RecoveryOptions): Promise<Ctx> {
  const fixtureEnv = run.fixtureEnv
  if (!fixtureEnv) throw new Error('[284] 场景必须有夹具环境（openT3Run 应带 withFixtures）')
  const registry = fixtureEnv.registry
  const scenario = run.scenario
  const step = scenario.install[0]
  const slot = fixtureSlotOf(step.slotKey)
  const packageName = slot.packageName
  const bridgeRoute = fixtureBridgeRouteOf(slot)
  const phonePrefix = slot.selfTargetPrefix
  if (!phonePrefix) throw new Error('[284] 席位 ' + slot.key + ' 缺单插件电话前缀')
  const baseVersion = baselineVersionOf(scenario, slot.key)
  const variantVersion = variantVersionOf(scenario, slot.key)
  if (!variantVersion) throw new Error('[284] 场景声明缺变体版本')

  const osHomeDir = join(run.layout.root, 'os-home')
  const homeDir = join(osHomeDir, '.dsh')
  await ensureDir(osHomeDir)
  await ensureDir(homeDir)
  const storeDir = join(run.layout.root, 'pnpm-store')
  await ensureDir(storeDir)
  process.env['pnpm_config_store_dir'] = storeDir
  const cacheDir = join(run.layout.root, 'pnpm-cache')
  await ensureDir(cacheDir)
  process.env['pnpm_config_cache_dir'] = cacheDir
  process.env['npm_config_cache'] = join(run.layout.root, 'npm-cache')

  // 产品取更新日志要求 dist.tarball 是 https 且与 registry 同源（src/core/changelog/io.ts:347-359），
  // 所以产品侧 registry 一律走本 run 的 TLS 前置；verdaccio 仍是仓库外 http，只当上游。
  const front = await startTlsRegistryFront({ upstreamBaseUrl: fixtureEnv.registry.baseUrl, certificateDir: join(run.layout.root, 'tls-registry-front') })
  // 端口释放证据统一在 cleanupContext 里等 front 真停后再登记。
  await run.raw('isolation-facts', {
    osHomeDir,
    homeDir,
    profileName: PROFILE_NAME,
    pnpmStoreDir: storeDir,
    pnpmCacheDir: cacheDir,
    npmCacheDir: process.env['npm_config_cache'] || null,
    registryUrl: front.baseUrl,
    upstreamRegistryUrl: fixtureEnv.registry.baseUrl,
    tlsFrontPort: front.port,
    certSha256: front.certSha256,
    playwrightDir: process.env['DSH_VERIFY_PLAYWRIGHT'] || null,
    node: process.version,
    platform: process.platform,
    equivalentHostBoundary:
      '宿主侧能力（desktopProfiles/desktopPnpm/pluginManager）由夹具模板经 deps.readerOverrides 注入；产品仍走真实路由/executor/电话/面板，安装由官方发行包的 CLI 真跑 pnpm 落到真磁盘',
  })

  const profile = await createWebProfileInHome({ homeDir, profileName: PROFILE_NAME })
  await run.raw('profile-create', {
    exitCode: profile.create.exitCode,
    stdout: profile.create.stdout,
    stderr: profile.create.stderr,
    profileDir: profile.profileDir,
  })
  run.record({
    step: '建普通 web profile（等效宿主的宿主环境）',
    what: '在 run 私有 DSH_HOME 里建一个普通 web 使用范围，基版装进它；产品对宿主种类的判定由 readerOverrides.environmentKind 显式给',
    expected: 'exit=0；profileDir=' + profile.profileDir,
    actual: 'exit=' + String(profile.create.exitCode) + '；profileDir=' + profile.profileDir,
    verdict: profile.create.exitCode === 0 ? 'pass' : 'fail',
  })
  const baseline = await run.publishBaseline()
  await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl: fixtureEnv.registry.baseUrl })
  const sutOk = await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName: fixtureEnv.sut.name })
  run.record({
    step: 'setup-sut',
    what: 'profile 里装的 SUT 与工作树构建一致',
    expected: 'installed distDigest === worktree distDigest',
    actual: String(sutOk),
    verdict: sutOk ? 'pass' : 'fail',
  })
  const baseDisk = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName })
  run.record({
    step: '基版在盘（更新前状态）',
    what: '更新前隔离 profile 的 node_modules 里装的是场景声明的基版 ' + baseVersion,
    expected: '磁盘版本=' + baseVersion,
    actual: '磁盘版本=' + String(baseDisk),
    verdict: baseDisk === baseVersion ? 'pass' : 'fail',
  })

  // 失败格 F3-A 必须让 pnpm 真的去 registry 下载 tarball：用带本 run 注入标记的内容构建
  // （integrity 与历史 run 不同，共享 store 不会命中缓存假装成功）。can-red 用 stale-variant。
  const fault: ScenarioFaultInjection | undefined =
    options.mode === 'can-red'
      ? {
          kind: 'stale-variant',
          slotKey: slot.key,
          description: 'can-red：发布 0.0.2 但构建内容仍是 0.0.1（host 构建标记不变），预期重启后「运行代码真的换了版」断言真红',
        }
      : undefined
  let variant: PublishedFixture
  if (fault) {
    const publication = await publishScenarioVariants(scenario, fixtureEnv, fault, baseline)
    variant = publication.variants[slot.key]
    await run.raw('can-red-fault-injection', {
      fault,
      spec: specOf(variant),
      why: '清单版本是 ' + variantVersion + '，但 tarball 内容仍是 ' + baseVersion + ' 的构建；用来证明「重启后运行代码真的换了版」断言不是永真',
    })
    run.addNote('can-red 故障注入：stale-variant——变体清单 ' + variantVersion + '，构建内容仍是 ' + baseVersion + '；预期 buildTag 断言真红')
  } else if (options.mode === 'f3') {
    const scenarioVariant = scenario.variants[0]
    const effect = {
      ...scenarioVariant.effect,
      seatLine: 'f3 失败格注入 ' + run.layout.stamp,
      hostBehavior: 'f3-failure-injection:' + run.layout.stamp,
    }
    variant = await fixtureEnv.publish(slot.key, variantVersion, { effect })
    await run.raw('failure-variant-injection', {
      why: '失败格必须让 pnpm 真去 registry 下载 tarball；共享 store 里可能已有历史 run 同 integrity 的 0.0.2，本 run 用带注入标记的内容构建（integrity 不同），删 tarball 后才会真的 404',
      effect,
      spec: specOf(variant),
    })
    run.addNote('F3 故障注入：变体 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同；构建标记仍 v0.0.2')
  } else {
    const publication = await publishScenarioVariants(scenario, fixtureEnv, undefined, baseline)
    variant = publication.variants[slot.key]
  }
  await run.raw('fixture-published-variant', { baseline: specOf(baseline[slot.key]), variant: specOf(variant) })

  return {
    run,
    mode: options.mode,
    homeDir,
    osHomeDir,
    profileName: PROFILE_NAME,
    registryUrl: front.baseUrl,
    upstreamRegistryUrl: fixtureEnv.registry.baseUrl,
    registry,
    front,
    slot,
    packageName,
    route: bridgeRoute,
    phonePrefix,
    checkPhone: phonePrefix + '.updateCheck',
    installPhone: phonePrefix + '.updateInstall',
    statusPhone: phonePrefix + '.updateStatus',
    buildTagPhone: fixtureBuildTagPhoneOf(slot),
    baseVersion,
    variantVersion,
    baseline: baseline[slot.key],
    variant,
    hosts: [],
  }
}

/** ${'}等效宿主 spec 的公共部分。 */
function hostSpecOf(ctx: Ctx, kind: EquivalentKind, extra: Record<string, unknown>): Record<string, unknown> {
  const specDir = join(ctx.run.layout.root, 'equivalent-host-specs')
  return {
    kind,
    rawDir: join(ctx.run.layout.rawDir, 'equivalent-host'),
    profileDir: join(ctx.homeDir, 'profiles', PROFILE_NAME),
    profileName: ctx.profileName,
    homeDir: ctx.homeDir,
    cliProfileName: ctx.profileName,
    cliExe: DSH_PATHS.exePath,
    cliJs: DSH_PATHS.cliJsPath,
    delayMs: 0,
    note: 'readerOverrides.environmentKind=' + kind + '（README deps.readerOverrides 集成方入口）；宿主服务对象由夹具提供，安装仍走官方发行包 CLI',
    specDir,
    ...extra,
  }
}

/** 写 spec 文件（run.json raw 里留原文，便于复跑）。 */
async function writeHostSpec(ctx: Ctx, label: string, spec: Record<string, unknown>): Promise<string> {
  const dir = join(ctx.run.layout.root, 'equivalent-host-specs')
  await ensureDir(dir)
  const file = join(dir, label + '.json')
  await writeFile(file, JSON.stringify(spec, null, 2) + '\n')
  await ctx.run.raw('equivalent-host-spec-' + label, spec)
  return file
}

/** 起一代宿主（kind='plain' 时不起等效宿主，用原始 profile；本文件目前只用等效宿主）。 */
async function startHost(ctx: Ctx, label: string, kind: EquivalentKind | 'plain', extra: Record<string, unknown> = {}, options: { withUi?: boolean } = {}): Promise<HostHandle> {
  const extraEnv: Record<string, string | undefined> = {
    DSH_SELFTEST_REGISTRY: ctx.registryUrl,
    NODE_EXTRA_CA_CERTS: ctx.front.certPath,
    DSH_SELFTEST_DESKTOP_EXE: DSH_PATHS.exePath,
    DSH_SELFTEST_DESKTOP_CLI_JS: DSH_PATHS.cliJsPath,
  }
  let specFile = ''
  if (kind !== 'plain') {
    // 每个宿主一份 rawDir：模板里的 capture 序号是宿主进程内模块级，共用目录会互相覆盖。
    const spec = hostSpecOf(ctx, kind, { rawDir: join(ctx.run.layout.rawDir, 'equivalent-host-' + label), ...extra })
    specFile = await writeHostSpec(ctx, label, spec)
    extraEnv['DSH_SELFTEST_EQUIVALENT_HOST'] = JSON.stringify(spec)
  }
  const timeoutMs = extra['installTimeoutMs']
  if (typeof timeoutMs === 'number' && timeoutMs > 0) extraEnv['DSH_SELFTEST_INSTALL_TIMEOUT_MS'] = String(timeoutMs)
  const host = await startCliHost({
    homeDir: ctx.homeDir,
    osHomeDir: ctx.osHomeDir,
    profileName: ctx.profileName,
    extraEnv,
  })
  ctx.run.registerProcess(label + '-host', host.pid() ?? null)
  // 端口释放证据在 stopHost 里等进程真退出后再登记（起进程时登记只会永远记 false）。
  const handle: HostHandle = {
    index: ctx.hosts.length,
    label,
    kind,
    host,
    ui: null,
    profileDir: join(ctx.homeDir, 'profiles', PROFILE_NAME),
    specPath: specFile,
    stopped: false,
  }
  ctx.hosts.push(handle)
  await ctx.run.raw('host-launch-' + label, {
    label,
    urlMasked: host.url.replace(/token=[^&]+/, 'token=***'),
    port: host.port,
    bootMs: host.bootMs,
    profileName: ctx.profileName,
    registryUrl: ctx.registryUrl,
    equivalentKind: kind,
    equivalentSpecPath: specFile.replace(/\\/g, '/'),
    installTimeoutMs: typeof timeoutMs === 'number' ? timeoutMs : null,
    stdoutTail: host.stdout().slice(-1600),
    stderrTail: host.stderr().slice(-1600),
  })
  if (options.withUi !== false) {
    handle.ui = await openUi(host.url)
    ctx.run.addNote('宿主 ' + label + ' 已起：kind=' + kind + '，port=' + String(host.port) + '，UI=' + handle.ui.label)
  }
  return handle
}

/** 停一代宿主（UI → 宿主），并登记 raw。 */
async function stopHost(ctx: Ctx, handle: HostHandle, reason = 'stop'): Promise<void> {
  if (handle.stopped) return
  handle.stopped = true
  if (handle.ui) {
    await handle.ui.close().catch(() => undefined)
    handle.ui = null
  }
  await handle.host.close().catch(() => undefined)
  await ctx.run.raw('host-stop-' + String(handle.index), {
    reason,
    gen: handle.index,
    kind: handle.kind,
    port: handle.host.port,
    pid: handle.host.pid() ?? null,
    equivalentSpecPath: handle.specPath.replace(/\\/g, '/'),
    stdoutTail: handle.host.stdout().slice(-4000),
    stderrTail: handle.host.stderr().slice(-4000),
  })
  await recordPortRelease(ctx, handle.label + '-host-port', handle.host.port)
}

/** 端口释放证据：等进程真退出、端口真空闲后再登记（registerPort 会立即测一次 isPortFree）。 */
async function recordPortRelease(ctx: Ctx, label: string, port: number): Promise<void> {
  // waitForPortFree 轮询到端口真回来（最多 5s）；registerPort 里还会再测一次并落 run.json。
  await waitForPortFree(port, 5000)
  await ctx.run.registerPort(label, port)
}

/** 收尾：停掉所有未停宿主，并在全部宿主停后统一收割日志。 */
async function cleanupContext(ctx: Ctx): Promise<void> {
  for (const handle of ctx.hosts) {
    if (!handle.stopped) await stopHost(ctx, handle, 'cleanup')
  }
  try {
    const capture = await captureLogFiles(ctx.run.recorder, ctx.homeDir)
    await ctx.run.raw('cleanup-log-files', { files: capture.snapshot.files, eventCount: capture.snapshot.events.length, truncations: capture.truncations.length })
  } catch (error) {
    ctx.run.addNote('日志收割失败：' + (error instanceof Error ? error.message : String(error)))
  }
  const frontRequests = ctx.front.requests()
  await ctx.run.raw('tls-front-stop', { port: ctx.front.port, requests: frontRequests.length, delayed: ctx.front.delayedCount(), certSha256: ctx.front.certSha256 })
  await ctx.front.stop().catch(() => undefined)
  await recordPortRelease(ctx, 'tls-registry-front', ctx.front.port)
}

/** 读产品日志快照（停宿主之后调用）。 */
async function readLogFacts(ctx: Ctx): Promise<{ events: LogEventRecord[]; execs: LogEventRecord[]; fails: LogEventRecord[]; requests: LogEventRecord[] }> {
  const snapshot = await readLogEvents(ctx.homeDir)
  const execs = snapshot.events.filter((event) => event.event === 'update.install.exec')
  const fails = snapshot.events.filter((event) => event.event === 'update.install.fail')
  const requests = snapshot.events.filter((event) => event.event === 'update.install.request')
  return { events: snapshot.events, execs, fails, requests }
}

/**
 * 等产品把 update.install.exec 写进日志再停宿主。
 * 作业终态（电话回包）比 exec 事件早：executor 在作业完成后才落 update.install.exec，
 * 磁盘 node_modules 也可能先到位。停宿主太早会让 exec 行来不及写盘（真机竞态：
 * 284-20261103T184726 的 route 断言读到空）。这不是放宽断言：超时后仍没有 exec 行，断言照样失败。
 */
async function waitForPackageExec(ctx: Ctx, timeoutMs = 30000): Promise<{ readonly appeared: boolean; readonly waitedMs: number }> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const facts = await readLogFacts(ctx)
    if (facts.execs.some((event) => isPackageEvent(event, ctx.packageName))) {
      return { appeared: true, waitedMs: Date.now() - startedAt }
    }
    await sleep(POLL_MS)
  }
  return { appeared: false, waitedMs: Date.now() - startedAt }
}

/** 产品插件短 id 是否指向该包（日志 pluginId 是更新电话前缀 fxa-a）。 */
function isPackageEvent(event: LogEventRecord, packageName: string): boolean {
  const pluginId = String(event.fields['pluginId'] || '')
  const short = packageName.slice(packageName.lastIndexOf('-') + 1)
  return pluginId === packageName || (pluginId !== '' && pluginId.endsWith('-' + short)) || String(event.source || '').indexOf(packageName) >= 0 || String(event.source || '').indexOf(short) >= 0
}

/** 该包的失败事件。 */
function packageFails(facts: { fails: LogEventRecord[] }, packageName: string): LogEventRecord[] {
  return facts.fails.filter((event) => isPackageEvent(event, packageName))
}

/** 该包收到安装请求的事件。 */
function packageRequests(facts: { requests: LogEventRecord[] }, packageName: string): LogEventRecord[] {
  return facts.requests.filter((event) => isPackageEvent(event, packageName))
}

/** 关键字定位安装上下文（宿主/商品码在 exec 事件一行里）。 */
function execLine(event: LogEventRecord): string {
  return JSON.stringify(event)
}

/** 读磁盘版本并等它到位。 */
async function waitDiskVersion(ctx: Ctx, expected: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  let last: string | null = null
  while (Date.now() < deadline) {
    last = await installedFixtureVersion({ homeDir: ctx.homeDir, profileName: ctx.profileName, packageName: ctx.packageName })
    if (last === expected) return last
    await sleep(POLL_MS)
  }
  return last
}

/**
 * 重启后读夹具构建标记（卡片里的 client/host tag）。
 * 夹具 client half（integrator-client-half-template.ts:192-193）用 data 属性承载：
 *   [data-fixture-build-tag] = 客户端半构建标记；[data-fixture-host-tag] = host 半电话回报的构建标记（初始占位 "host ?"）。
 * 标题在 [data-fixture-section="title"]。
 */
async function readBuildTags(ui: UiHandle, slot: FixtureSlot): Promise<{ clientTag: string | null; hostTag: string | null; title: string | null }> {
  const result = await ui.page.evaluate<{ clientTag: string | null; hostTag: string | null; title: string | null }>(
    '(function(){var card=document.querySelector(' + JSON.stringify(cardSelectorOf(slot.key)) + ');if(!card)return {clientTag:null,hostTag:null,title:null};function a(n){var el=card.querySelector("["+n+"]");return el?String(el.getAttribute(n)||"").trim():null}var t=card.querySelector("[data-fixture-section=\\"title\\"]");return {clientTag:a("data-fixture-build-tag"),hostTag:a("data-fixture-host-tag"),title:t?String(t.textContent||"").trim():null}})()',
  )
  return result
}

/** 等构建标记到位（host half 的构建标记来自挂载时的一次电话，初始占位 "host ?"，最多等 20s）。 */
async function waitForBuildTags(ui: UiHandle, slot: FixtureSlot, expected: { clientTag: string; hostTag: string }, timeoutMs = 20000): Promise<{ clientTag: string | null; hostTag: string | null; title: string | null }> {
  const deadline = Date.now() + timeoutMs
  let last = await readBuildTags(ui, slot)
  while (Date.now() < deadline) {
    if (last.clientTag === expected.clientTag && last.hostTag === expected.hostTag) return last
    await sleep(POLL_MS)
    last = await readBuildTags(ui, slot)
  }
  return last
}

/** 等卡片挂载（body 出现夹具卡片）。 */
async function waitForCard(ui: UiHandle, timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let body = ''
  while (Date.now() < deadline) {
    body = await ui.page.innerText('body').catch(() => '')
    if (body.indexOf('dsh-fixture-card') >= 0 || (await ui.page.evaluate<boolean>('(function(){return !!document.querySelector(".dsh-fixture-card")})()').catch(() => false))) return body
    await sleep(POLL_MS)
  }
  throw new Error('等夹具卡片挂载超时；body 前 2000 字=' + body.slice(0, 2000))
}

/** 在卡片内按 selector 点击；找不到返回 false（不抛错）。 */
async function clickIfPresent(ui: UiHandle, cardSelector: string, selector: string): Promise<boolean> {
  return ui.page.evaluate<boolean>('(function(){var card=document.querySelector(' + JSON.stringify(cardSelector) + ');if(!card)return false;var el=card.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true})()').catch(() => false)
}

/** 等面板横幅满足条件（只读，不触发 refresh）。 */
async function waitForPanelBanner(ui: UiHandle, slot: FixtureSlot, predicate: (state: CardState) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<CardState> {
  const deadline = Date.now() + timeoutMs
  let last: CardState | null = null
  while (Date.now() < deadline) {
    last = await readCard(ui, slot)
    if (last.banner !== null && predicate(last)) return last
    await sleep(POLL_MS)
  }
  throw new Error('等面板横幅超时（' + label + '）：last=' + JSON.stringify({ banner: last ? last.banner : null, install: last ? last.install : null }))
}

/** 等面板横幅满足条件；超时不抛错，返回最后一次读数与错误（供失败格记录而不是把场景打成 unknown）。 */
async function tryWaitForPanelBanner(ui: UiHandle, slot: FixtureSlot, predicate: (state: CardState) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<{ state: CardState | null; error: string | null }> {
  try {
    return { state: await waitForPanelBanner(ui, slot, predicate, label, timeoutMs), error: null }
  } catch (error) {
    return { state: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 两步检查（与 K1 真机流程一致）：先点面板检查等可更新横幅，再点安装按钮自身的检查等 install 动作。 */
async function checkUntilInstallable(ui: UiHandle, slot: FixtureSlot): Promise<CardState> {
  const cardSelector = cardSelectorOf(slot.key)
  await waitForPanelBanner(ui, slot, (state) => state.banner !== null && state.banner.kind !== 'loading', '面板状态回填（非 loading）')
  const panelCheck = '.dsh-upd[data-plugin="' + slot.packageName + '"] button[data-action="check"]'
  const panelClicked = await clickIfPresent(ui, cardSelector, panelCheck)
  if (!panelClicked) throw new Error('面板里找不到 check 按钮：' + panelCheck)
  await waitForPanelBanner(ui, slot, (state) => state.banner !== null && state.banner.kind === 'update', '点面板检查后出现可更新横幅')
  // 面板检查后：安装按钮可能直接切到 update（含 install），也可能仍是 loading 需要点它自己的 check。
  // 两种都接受，统一轮询到 install 动作（最多 20s）；期间若出现可点的 check 就补点一次（K1 同款两步的兜底）。
  const deadline = Date.now() + 20000
  let last: CardState | null = null
  let clickedIbCheck = false
  while (Date.now() < deadline) {
    last = await readCard(ui, slot)
    const buttons = last.install ? last.install.buttons : []
    if (buttons.some((button) => button.action === 'install')) return last
    if (!clickedIbCheck) {
      const checkable = buttons.some((button) => button.action === 'check' && !button.disabled)
      if (checkable) clickedIbCheck = await clickIfPresent(ui, cardSelector, '.dsh-upd-ib button[data-action="check"]')
    }
    await sleep(POLL_MS)
  }
  throw new Error('点面板检查后 20s 内安装按钮没出现 install 动作：last=' + JSON.stringify(last ? { banner: last.banner, install: last.install } : null))
}

/** 在等效桌面宿主里点一次「更新」并等作业终态；返回终态观测。 */
async function installViaUi(ctx: Ctx, handle: HostHandle, options: { timeoutMs?: number } = {}): Promise<{
  readonly card: CardState
  readonly buttonsBefore: CardState | null
  readonly outcome: Awaited<ReturnType<typeof callPhone>>
  readonly job: Record<string, unknown>
  readonly terminalElapsedMs: number
}> {
  const ui = handle.ui
  if (!ui) throw new Error('宿主代 ' + String(handle.index) + ' 没有 UI 会话')
  const cardBefore = await readCard(ui, ctx.slot)
  void cardBefore
  const withInstall = await checkUntilInstallable(ui, ctx.slot)
  await clickInCard(ui, cardSelectorOf(ctx.slot.key), '.dsh-upd-ib button[data-action="install"]')
  const outcome = await waitForTerminalJob(handle.host, ctx.route, ctx.statusPhone, options.timeoutMs ?? INSTALL_TIMEOUT_MS)
  const card = await readCard(ui, ctx.slot).catch(() => withInstall)
  return {
    card,
    buttonsBefore: withInstall,
    outcome: outcome.outcome,
    job: jobFacts(outcome.outcome),
    terminalElapsedMs: outcome.elapsedMs,
  }
}

/** 断言：产品 exec 日志一行（route/ok/exitCode）与失败码。 */
async function recordExecAssertions(run: T3Run, facts: { execs: LogEventRecord[]; fails: LogEventRecord[] }, packageName: string, step: string, expectedRoute: string): Promise<LogEventRecord[]> {
  const execs = facts.execs.filter((event) => isPackageEvent(event, packageName))
  const last = execs.length > 0 ? execs[execs.length - 1] : null
  const route = last ? String(last.fields['route'] ?? '') : ''
  const ok = last ? last.fields['ok'] : null
  const exitCode = last ? last.fields['exitCode'] : null
  run.record({
    step: step + '：产品安装执行日志',
    what: '真机产品日志里这次安装的 route/ok/exitCode（update.install.exec 事件）',
    expected: 'route=' + expectedRoute + '；ok=true；exitCode=0（成功格）或 ok=false + update.install.fail 一行（失败格）',
    actual: 'route=' + route + '；ok=' + String(ok) + '；exitCode=' + String(exitCode) + '；exec 条数=' + String(execs.length),
    verdict: last ? 'pass' : 'fail',
  })
  const fails = packageFails(facts, packageName)
  const fail = fails.length > 0 ? fails[fails.length - 1] : null
  if (fail) {
    const reason = String(fail.fields['reason'] ?? '')
    const code = String(fail.fields['code'] ?? '')
    const detail = String(fail.fields['detail'] ?? '')
    run.record({
      step: step + '：产品失败日志（update.install.fail）',
      what: '失败格的产品失败事实：stage/reason/code/detail 原文',
      expected: 'stage=exec；code=' + INSTALL_FAIL_CODE + '；reason=' + (expectedRoute === 'desktop-manager' ? 'timeout' : 'nonzero-exit|timeout') + '；detail 为宿主原话',
      actual: 'stage=' + String(fail.fields['stage'] ?? '') + '；reason=' + reason + '；code=' + code + '；detail=' + detail,
      verdict: code === INSTALL_FAIL_CODE && reason !== '' ? 'pass' : 'fail',
    })
  }
  return execs
}

/** 摘掉/写回 profile 清单里的「在册」事实（I4 用；与产品 src/core/reader.ts:355-361 同口径）。 */
async function rewriteEnrollment(options: {
  homeDir: string
  profileName: string
  packageName: string
  present: boolean
}): Promise<{ path: string; mode: 'bundles' | 'dependencies'; before: string; after: string; bundlesBefore: string[] | null; bundlesAfter: string[] | null; changed: boolean }> {
  const manifestPath = join(options.homeDir, 'profiles', options.profileName, 'package.json')
  const before = await readFile(manifestPath, 'utf8')
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(before) as Record<string, unknown>
  } catch {
    json = {}
  }
  const dependencies = (json['dependencies'] && typeof json['dependencies'] === 'object' ? json['dependencies'] : {}) as Record<string, string>
  let mode: 'bundles' | 'dependencies' = 'dependencies'
  let bundlesBefore: string[] | null = null
  let bundlesAfter: string[] | null = null
  const dsh = (json['dsh'] && typeof json['dsh'] === 'object' ? json['dsh'] : {}) as Record<string, unknown>
  const profile = (dsh['profile'] && typeof dsh['profile'] === 'object' ? dsh['profile'] : null) as Record<string, unknown> | null
  if (profile && Array.isArray(profile['bundles'])) {
    mode = 'bundles'
    const current = (profile['bundles'] as string[]).slice()
    bundlesBefore = current.slice()
    const filtered = current.filter((name) => name !== options.packageName)
    bundlesAfter = options.present && filtered.indexOf(options.packageName) < 0 ? filtered.concat([options.packageName]) : filtered
    profile['bundles'] = bundlesAfter
    dsh['profile'] = profile
    json['dsh'] = dsh
  } else if (options.present) {
    dependencies[options.packageName] = dependencies[options.packageName] || ''
  } else {
    delete dependencies[options.packageName]
  }
  json['dependencies'] = dependencies
  const after = JSON.stringify(json, null, 2) + '\n'
  await writeFile(manifestPath, after)
  return { path: manifestPath, mode, before, after, bundlesBefore, bundlesAfter, changed: after !== before }
}

/** 记录等效宿主边界（note + raw），每个 run 都写。 */
async function recordEquivalentHostBoundary(ctx: Ctx, handle: HostHandle, detail: Record<string, unknown>): Promise<void> {
  const payload = {
    kind: handle.kind,
    why: '本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板',
    whatIsReal: '产品源码路径（environment.ts 路由、executor.ts 执行器、电话/面板、日志、失败码与人话格）全部真实；安装由官方发行包 CLI（dsh plugin add --save-exact --registry）真跑 pnpm 落到真磁盘',
    whatIsStubbed: '宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带',
    specPath: handle.specPath.replace(/\\/g, '/'),
    ...detail,
  }
  await ctx.run.raw('equivalent-host-boundary-' + String(handle.index), payload)
  ctx.run.addNote('等效宿主边界（' + String(handle.index) + '，kind=' + String(handle.kind) + '）：' + payload.why + '；stub=' + payload.whatIsStubbed)
}

/** F2：出口一成功格 + can-red（重启后运行代码真换版）。 */
async function runF2(ctx: Ctx): Promise<void> {
  const run = ctx.run
  const handle = await startHost(ctx, 'exit-one', 'desktop', { installTimeoutMs: INSTALL_TIMEOUT_MS })
  await recordEquivalentHostBoundary(ctx, handle, { mode: ctx.mode })
  const ui = handle.ui
  if (!ui) throw new Error('[f2] 宿主没有 UI')
  await waitForCard(ui)
  const before = await readCard(ui, ctx.slot)
  await capture(run, ui, {
    step: 'f2-before',
    what: '更新前的夹具卡片（单面板：未安装/已安装版本 + 更新按钮档）',
    expected: '卡片挂载、显示基版 ' + ctx.baseVersion,
    actual: 'text=' + before.text.slice(0, 600),
    verdict: 'pass',
  })
  const installed = await installViaUi(ctx, handle)
  await capture(run, ui, {
    step: 'f2-after-install',
    what: '安装作业终态后的卡片（产品人话格 + 待重启语义）',
    expected: '作业终态 completed|restart-required；卡片显示待重启/已了结',
    actual: 'state=' + String(installed.job['state']) + '；code=' + String(jobCodeOf(installed.job)) + '；text=' + installed.card.text.slice(0, 600),
    verdict: isTerminalJob(installed.job['state']) ? 'pass' : 'fail',
  })
  const jobState = String(installed.job['state'] ?? '')
  run.record({
    step: 'f2 安装作业终态',
    what: '等效第三方 Desktop（desktopProfiles+desktopPnpm）里点「更新」后的产品作业终态',
    expected: 'completed 或 restart-required；product code=null；耗时 < ' + String(INSTALL_TIMEOUT_MS) + 'ms',
    actual: 'state=' + jobState + '；code=' + String(jobCodeOf(installed.job)) + '；message=' + jobMessageOf(installed.job).slice(0, 600) + '；elapsedMs=' + String(installed.terminalElapsedMs),
    verdict: (jobState === 'completed' || jobState === 'restart-required') && jobCodeOf(installed.job) === null ? 'pass' : 'fail',
  })
  const diskAfter = await waitDiskVersion(ctx, ctx.variantVersion)
  run.record({
    step: 'f2 磁盘版本（安装后）',
    what: '作业报成功后磁盘 node_modules 里夹具包的实际版本',
    expected: ctx.packageName + '@' + ctx.variantVersion,
    actual: String(diskAfter),
    verdict: diskAfter === ctx.variantVersion ? 'pass' : 'fail',
  })
  // exec 事件在作业完成之后异步落盘（见 waitForPackageExec 注释）：等它出现再停宿主。
  const execWait = await waitForPackageExec(ctx)
  await run.raw('f2-exec-log-wait', { appeared: execWait.appeared, waitedMs: execWait.waitedMs, timeoutMs: 30000 })
  if (!execWait.appeared) run.addNote('f2 等 update.install.exec 超时 30s 仍没出现（断言将如实失败，不重试掩盖）。')
  await stopHost(ctx, handle, 'after-install')

  // 真机日志：路线必须是 desktop-service（出口一），成功 exec 一行、没有该包的失败行。
  const facts = await readLogFacts(ctx)
  await run.raw('install-log-facts', {
    execs: facts.execs.map(execLine),
    fails: facts.fails.map(execLine),
    requests: packageRequests(facts, ctx.packageName).map(execLine),
  })
  const execs = facts.execs.filter((event) => isPackageEvent(event, ctx.packageName))
  const lastExec = execs.length > 0 ? execs[execs.length - 1] : null
  const route = lastExec ? String(lastExec.fields['route'] ?? '') : ''
  run.record({
    step: 'f2 产品路线（真机日志）',
    what: '产品日志 update.install.exec 的 route 必须落在出口一 desktop-service',
    expected: 'route=desktop-service；ok=true；exitCode=0',
    actual: 'route=' + route + '；ok=' + String(lastExec ? lastExec.fields['ok'] : null) + '；exitCode=' + String(lastExec ? lastExec.fields['exitCode'] : null),
    verdict: route === 'desktop-service' && lastExec !== null && lastExec.fields['ok'] === true ? 'pass' : 'fail',
  })
  const fails = packageFails(facts, ctx.packageName)
  run.record({
    step: 'f2 成功格不该有失败行',
    what: '产品日志 update.install.fail 里没有该包',
    expected: '0 条',
    actual: String(fails.length) + ' 条' + (fails.length > 0 ? '：' + execLine(fails[fails.length - 1]).slice(0, 500) : ''),
    verdict: fails.length === 0 ? 'pass' : 'fail',
  })

  // 重启（同一等效宿主 spec）：新进程从磁盘加载变体版，夹具 host half 的构建标记换版 = 运行代码真的换了。
  const restarted = await startHost(ctx, 'exit-one-restarted', 'desktop', { installTimeoutMs: INSTALL_TIMEOUT_MS })
  const ui2 = restarted.ui
  if (!ui2) throw new Error('[f2] 重启宿主没有 UI')
  await waitForCard(ui2)
  const expectedHost = fixtureBuildTagsOf(ctx.slot, ctx.variantVersion as '0.0.2', ctx.run.scenario.variants[0].effect).hostTag
  const expectedClient = fixtureBuildTagsOf(ctx.slot, ctx.variantVersion as '0.0.2', ctx.run.scenario.variants[0].effect).clientTag
  const tags = await waitForBuildTags(ui2, ctx.slot, { clientTag: expectedClient, hostTag: expectedHost })
  await capture(run, ui2, {
    step: 'f2-after-restart',
    what: '重启后卡片上的夹具构建标记（client/host tag）与标题',
    expected: 'client=' + expectedClient + '；host=' + expectedHost + '（运作代码来自变体版）',
    actual: 'client=' + String(tags.clientTag) + '；host=' + String(tags.hostTag) + '；title=' + String(tags.title),
    verdict: tags.hostTag === expectedHost && tags.clientTag === expectedClient ? 'pass' : 'fail',
  })
  run.record({
    step: 'f2 重启后运行代码真换版',
    what: '停宿主再起同构宿主：磁盘变体版里 host half 的构建标记必须变成 v' + ctx.variantVersion + '（不是只看清单/台账）',
    expected: 'hostTag=' + expectedHost,
    actual: 'hostTag=' + String(tags.hostTag),
    verdict: tags.hostTag === expectedHost ? 'pass' : 'fail',
  })
  await stopHost(ctx, restarted, 'after-restart')
}

/** 读某代宿主自己的等效宿主采集目录（模板 capture 的 JSON，按文件名排序）。 */
async function readEquivalentHostCaptures(ctx: Ctx, label: string): Promise<{ file: string; payload: Record<string, any> }[]> {
  const dir = join(ctx.run.layout.rawDir, 'equivalent-host-' + label)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
  const captures: { file: string; payload: Record<string, any> }[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const payload = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
      captures.push({ file: path.replace(/\\/g, '/'), payload })
    } catch {
      // 坏文件不拖垮断言：保留其余采集
    }
  }
  return captures
}

/** 采集 JSON 的可读摘要（raw 用，长输出截尾）。 */
function captureSummary(captures: { file: string; payload: Record<string, any> }[]): Record<string, unknown>[] {
  return captures.map((item) => {
    const payload = item.payload
    const argv = Array.isArray(payload['argv']) ? payload['argv'] : (Array.isArray(payload['args']) ? payload['args'] : null)
    return {
      file: item.file,
      phase: payload['phase'] ?? null,
      mode: payload['mode'] ?? null,
      argv,
      cwd: payload['cwd'] ?? null,
      exitCode: Object.prototype.hasOwnProperty.call(payload, 'exitCode') ? payload['exitCode'] : null,
      packageSpec: payload['packageSpec'] ?? null,
      requestId: payload['requestId'] ?? null,
      application: payload['application'] ?? null,
      delayMs: payload['delayMs'] ?? null,
      stdoutTail: typeof payload['stdout'] === 'string' ? (payload['stdout'] as string).slice(-1200) : null,
      stderrTail: typeof payload['stderr'] === 'string' ? (payload['stderr'] as string).slice(-1200) : null,
    }
  })
}

/** 采集里是否出现任何 cancel 调用（用来证明「没有 cancelInstall 时产品也没乱调」）。 */
function hasCancelCapture(captures: { payload: Record<string, any> }[]): boolean {
  return captures.some((item) => String(item.payload['phase'] ?? '').indexOf('cancel') >= 0)
}

/** 卡片是否在 DOM 里（未加载插件时为 false，不等待）。 */
async function cardPresence(ui: UiHandle, slot: FixtureSlot): Promise<boolean> {
  return ui.page
    .evaluate<boolean>('(function(){return !!document.querySelector(' + JSON.stringify(cardSelectorOf(slot.key)) + ')})()')
    .catch(() => false)
}

/** 同一浏览器上下文里重新打开 UI（token cookie 已在；页面句柄没有 reload）。 */
async function reopenUi(ui: UiHandle, tokenUrl: string): Promise<string> {
  await ui.page.goto(tokenUrl, { waitUntil: 'load', timeout: 60000 })
  const deadline = Date.now() + 30000
  let body = ''
  while (Date.now() < deadline) {
    body = await ui.page.innerText('body').catch(() => '')
    if (body.trim().length > 0) break
    await sleep(250)
  }
  if (body.includes(AUTH_REQUIRED_MARKER)) throw new Error('重新打开 UI 时鉴权失败（body 含 authentication required）')
  return body
}

/** URL 归一化（只用于比较 registry 是否同一个源）。 */
function normalizeUrl(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : ''
}

/**
 * 清掉上一格失败作业的持久化面板状态（home/.dsh/updates/<前缀>/<hash>/state.json 与 update-queue/<hash>/queue.json）。
 * 面板横幅由 state.json 重建：F3-A 的失败状态会粘住下一次检查（横幅一直停 failed），
 * F3-B 需要从「干净面板 → check → install」开始。只动这份面板状态，不动磁盘上的包。
 */
async function resetPersistedPanelState(ctx: Ctx, label: string): Promise<void> {
  const run = ctx.run
  const roots = [join(ctx.homeDir, 'update-queue'), join(ctx.homeDir, 'updates')]
  const snapshot: { path: string; bytes: number; contentTail: string }[] = []
  async function walk(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      const isDir = await readdir(path).then(() => true, () => false)
      if (isDir) {
        await walk(path)
        continue
      }
      try {
        const text = await readFile(path, 'utf8')
        snapshot.push({ path: path.replace(/\\/g, '/'), bytes: text.length, contentTail: text.slice(-1200) })
      } catch {
        // 读不到的单文件不拖垮清理
      }
    }
  }
  for (const root of roots) await walk(root)
  const hadFailedState = snapshot.some((item) => item.path.endsWith('state.json') && item.contentTail.indexOf('"state": "failed"') >= 0)
  for (const root of roots) await rm(root, { recursive: true, force: true })
  const absentAfter = (await Promise.all(roots.map((root) => readdir(root).then(() => false, () => true)))).every(Boolean)
  await run.raw(label, {
    roots: roots.map((root) => root.replace(/\\/g, '/')),
    filesBefore: snapshot,
    hadFailedState,
    absentAfter,
    note: '面板横幅由持久化 state.json 重建；清掉上一格失败状态后，新宿主从 check 开始（磁盘上的安装不变）',
  })
  run.record({
    step: 'f3b 前置：清掉上一格持久化失败状态（干净面板，不动磁盘安装）',
    what: '清 home/.dsh/updates 与 update-queue：F3-A 的失败作业状态会让面板横幅一直停在「更新失败」',
    expected: '清理前读到 state=failed（带 install-failed 原文）；清理后两个目录都不存在',
    actual: 'files=' + String(snapshot.length) + '；hadFailedState=' + String(hadFailedState) + '；absentAfter=' + String(absentAfter),
    verdict: hadFailedState && absentAfter ? 'pass' : 'fail',
  })
}

/** F3：出口一失败格（A 注册表 tarball 404 真失败 + B 超时无终止能力）。 */
async function runF3(ctx: Ctx): Promise<void> {
  await runF3RegistryFailure(ctx)
  await resetPersistedPanelState(ctx, 'f3b-panel-state-reset')
  await runF3TimeoutNoTerminate(ctx)
}

/** F3-A：check 通过后下架变体 tarball，让真 pnpm 在安装阶段 404（exit-one 真失败）。 */
async function runF3RegistryFailure(ctx: Ctx): Promise<void> {
  const run = ctx.run
  const handle = await startHost(ctx, 'exit-one-registry-fail', 'desktop', { installTimeoutMs: INSTALL_TIMEOUT_MS })
  await recordEquivalentHostBoundary(ctx, handle, {
    subcase: 'A-registry-tarball-404',
    whyThisSubcase: 'check 已经通过（元数据/integrity 都在），再删 tarball：产品 recipe 不变，真 pnpm 取包时 404 → 非零退出',
  })
  const ui = handle.ui
  if (!ui) throw new Error('[f3a] 宿主没有 UI')
  await waitForCard(ui)
  await checkUntilInstallable(ui, ctx.slot)

  const fault = await removePublishedTarball({
    registry: ctx.registry,
    backupDir: join(run.layout.root, 'registry-tarball-backup'),
    packageName: ctx.packageName,
    version: ctx.variantVersion,
  })
  await run.raw('f3a-registry-tarball-fault', {
    packageName: fault.packageName,
    version: fault.version,
    tarballUrl: fault.tarballUrl,
    tarballPath: fault.tarballPath,
    backupPath: fault.backupPath,
    sizeBefore: fault.sizeBefore,
    versionDocUnchanged: fault.versionDocUnchanged,
    servedBeforeStatus: fault.servedBeforeStatus,
    servedBeforeBytes: fault.servedBeforeBytes,
    servedAfterStatus: fault.servedAfterStatus,
    servedAfterBody: String(fault.servedAfterBody ?? '').slice(0, 400),
  })
  run.record({
    step: 'f3a 故障注入：变体 tarball 下架',
    what: 'check 通过后只删 tarball 文件（版本元数据与 integrity 不动）：删前 200 非空、删后 404',
    expected: 'servedBeforeStatus=200 且字节>0；servedAfterStatus=404；versionDocUnchanged=true',
    actual: 'before=' + String(fault.servedBeforeStatus) + '/' + String(fault.servedBeforeBytes) + 'B；after=' + String(fault.servedAfterStatus) + '；versionDocUnchanged=' + String(fault.versionDocUnchanged),
    verdict: fault.servedBeforeStatus === 200 && fault.servedBeforeBytes > 0 && fault.servedAfterStatus === 404 && fault.versionDocUnchanged === true ? 'pass' : 'fail',
  })
  run.addNote('f3a 注入：check 通过后下架 ' + specOf(ctx.variant) + ' 的 tarball（元数据保留）→ 安装阶段应 404；本 run 结束前恢复。')

  let restore: Awaited<ReturnType<typeof restorePublishedTarball>> | null = null
  let restoreError: string | null = null
  try {
    await clickInCard(ui, cardSelectorOf(ctx.slot.key), '.dsh-upd-ib button[data-action="install"]')
    const terminal = await waitForTerminalJob(handle.host, ctx.route, ctx.statusPhone, INSTALL_TIMEOUT_MS)
    const outcome = terminal.outcome
    const job = jobFacts(outcome)
    const message = jobMessageOf(job)
    const jobState = String(job['state'] ?? '')
    const code = jobCodeOf(job)
    await run.raw('f3a-phone-status-terminal', {
      state: jobState,
      code,
      message,
      elapsedMs: terminal.elapsedMs,
      polls: terminal.polls,
      replyStatus: outcome.reply.status,
      replyDurationMs: outcome.reply.durationMs,
    })
    run.record({
      step: 'f3a 安装作业终态',
      what: '出口一 registry 类失败（tarball 404）下产品给用户的作业终态',
      expected: 'state=failed；code=install-failed（产品码不泄漏成 pnpm 原始码）',
      actual: 'state=' + jobState + '；code=' + String(code) + '；message=' + message.slice(0, 700),
      verdict: jobState === 'failed' && code === INSTALL_FAIL_CODE ? 'pass' : 'fail',
    })
    run.record({
      step: 'f3a 失败发生在 install、不是超时兜底',
      what: 'tarball 404 应立即失败（远小于 installTimeoutMs=' + String(INSTALL_TIMEOUT_MS) + 'ms）',
      expected: 'elapsedMs < 60000',
      actual: 'elapsedMs=' + String(terminal.elapsedMs),
      verdict: terminal.elapsedMs < 60000 ? 'pass' : 'fail',
    })
    run.record({
      step: 'f3a 人话格保留宿主原话（pnpm 404）',
      what: '失败 message/detail 里能读到 pnpm 的原始报错（ERR_PNPM_*/404/fetch），不是只剩裸码',
      expected: '含 ERR_PNPM 或 404 或 fetch（大小写不敏感）',
      actual: message.slice(0, 900),
      verdict: /ERR_PNPM|404|fetch/i.test(message) ? 'pass' : 'fail',
    })
    const carrier = message.indexOf('dsh plugin --profile') >= 0 || message.indexOf('--registry=') >= 0
    run.record({
      step: 'f3a registry 类失败不出现载体命令',
      what: 'registry 类失败给不出可执行载体命令（契约：这类失败没有命令），诚实面不得出现 dsh plugin --profile/--registry=',
      expected: '不含 dsh plugin --profile，不含 --registry=',
      actual: 'carrier=' + String(carrier) + '；message=' + message.slice(0, 500),
      verdict: carrier ? 'fail' : 'pass',
    })

    // 面板是独立轮询（夹具页挂载时 pollMs=5000）：作业终态后要等面板下一次刷新，不能立刻读 DOM 当结论。
    const failurePanel = await tryWaitForPanelBanner(ui, ctx.slot, (state) => state.banner !== null && state.banner.kind === 'failed', 'f3a tarball404 失败横幅', 30000)
    const card = failurePanel.state ?? (await readCard(ui, ctx.slot))
    const bannerKind = card.banner ? card.banner.kind : null
    const cardText = card.text
    const honest = bannerKind === 'failed' && cardText.indexOf('已是最新') < 0 && cardText.indexOf('更新成功') < 0
    run.record({
      step: 'f3a 失败后面板不撒谎',
      what: 'tarball 404 失败后面板（5s 轮询刷新后）显示失败横幅，且不出现「已是最新 / 更新成功」等成功话术',
      expected: 'banner.kind=failed；卡片不出现「已是最新 / 更新成功」',
      actual: 'banner=' + JSON.stringify(card.banner) + '；install=' + JSON.stringify(card.install) + '；waitError=' + String(failurePanel.error) + '；text=' + cardText.slice(0, 600),
      verdict: honest ? 'pass' : 'fail',
    })
    await capture(run, ui, {
      step: 'f3a-failed-panel',
      what: 'tarball 404 失败后的面板：失败横幅与磁盘/版本读数',
      expected: 'banner.kind=failed；卡片不出现「已是最新 / 更新成功」等成功话术',
      actual: 'banner=' + JSON.stringify(card.banner) + '；install=' + JSON.stringify(card.install) + '；text=' + cardText.slice(0, 900),
      verdict: honest ? 'pass' : 'fail',
    })
    const diskAfter = await installedFixtureVersion({ homeDir: ctx.homeDir, profileName: ctx.profileName, packageName: ctx.packageName })
    run.record({
      step: 'f3a 失败后磁盘仍是基版',
      what: 'pnpm 取包 404 → node_modules 里夹具包版本不变',
      expected: ctx.baseVersion,
      actual: String(diskAfter),
      verdict: diskAfter === ctx.baseVersion ? 'pass' : 'fail',
    })
  } finally {
    try {
      restore = await restorePublishedTarball({ registry: ctx.registry, fault })
    } catch (error) {
      restoreError = error instanceof Error ? error.message : String(error)
      await run.raw('f3a-registry-tarball-restore-error', { message: restoreError })
    }
  }
  await run.raw('f3a-registry-tarball-restore', { restore, restoreError })
  run.record({
    step: 'f3a 源恢复',
    what: 'run 收尾前把下架的 tarball 放回：再取 200 且版本文档未变（不影响后续格）',
    expected: 'restoredStatus=200；versionDocUnchanged=true',
    actual: 'restore=' + JSON.stringify(restore) + '；error=' + String(restoreError),
    verdict: restore !== null && restore.restoredStatus === 200 && restore.versionDocUnchanged === true ? 'pass' : 'fail',
  })

  await stopHost(ctx, handle, 'after-failure')
  const captures = await readEquivalentHostCaptures(ctx, 'exit-one-registry-fail')
  await run.raw('f3a-equivalent-host-captures', {
    dir: join(run.layout.rawDir, 'equivalent-host-exit-one-registry-fail').replace(/\\/g, '/'),
    captures: captureSummary(captures),
  })
  const runPlugin = captures.find((item) => item.payload['phase'] === 'runPlugin') ?? null
  // 模板的 runPlugin 采集在真 CLI 退出后写 argv/exitCode/stdout/stderr（没有单独的 cli 阶段）。
  const runPluginPayload = runPlugin ? runPlugin.payload : null
  const pluginArgs = runPluginPayload && Array.isArray(runPluginPayload['argv']) ? (runPluginPayload['argv'] as unknown[]).map(String) : []
  const cliExit = runPluginPayload ? runPluginPayload['exitCode'] : null
  const cliOutput = runPluginPayload ? String(runPluginPayload['stdout'] ?? '') + String(runPluginPayload['stderr'] ?? '') : ''
  const specToken = ctx.packageName + '@' + ctx.variantVersion
  run.record({
    step: 'f3a 等效宿主真的跑了 CLI（不是假回包）',
    what: 'runPlugin 采集：mode=real-cli；参数含 plugin/add/包@变体/--registry；CLI 退出码非 0 且输出是 pnpm 原话',
    expected: 'mode=real-cli；args 含 add 与 ' + specToken + '；exitCode≠0；输出含 ERR_PNPM/404/fetch',
    actual: 'mode=' + String(runPlugin ? runPlugin.payload['mode'] : null) + '；args=' + JSON.stringify(pluginArgs).slice(0, 500) + '；exitCode=' + String(cliExit) + '；outputTail=' + cliOutput.slice(-700),
    verdict: runPlugin !== null && runPlugin.payload['mode'] === 'real-cli' && pluginArgs.indexOf('add') >= 0 && pluginArgs.indexOf(specToken) >= 0 && pluginArgs.some((arg) => arg.indexOf('--registry=') === 0) && typeof cliExit === 'number' && cliExit !== 0 && /ERR_PNPM|404|fetch/i.test(cliOutput) ? 'pass' : 'fail',
  })

  const facts = await readLogFacts(ctx)
  await run.raw('f3a-install-log-facts', {
    execs: facts.execs.map(execLine),
    fails: facts.fails.map(execLine),
    requests: packageRequests(facts, ctx.packageName).map(execLine),
  })
  await recordExecAssertions(run, facts, ctx.packageName, 'f3a', 'desktop-service')
  const execs = facts.execs.filter((event) => isPackageEvent(event, ctx.packageName))
  const lastExec = execs.length > 0 ? execs[execs.length - 1] : null
  const execRoute = lastExec ? String(lastExec.fields['route'] ?? '') : ''
  const execOk = lastExec ? lastExec.fields['ok'] : null
  const execExit = lastExec ? lastExec.fields['exitCode'] : null
  run.record({
    step: 'f3a 产品失败日志：路线/非零退出',
    what: 'update.install.exec 记录 route=desktop-service、ok=false、exitCode 非 0（真 CLI 非零退出）',
    expected: 'route=desktop-service；ok=false；exitCode 是数字且≠0',
    actual: 'route=' + execRoute + '；ok=' + String(execOk) + '；exitCode=' + String(execExit),
    verdict: execRoute === 'desktop-service' && execOk === false && typeof execExit === 'number' && execExit !== 0 ? 'pass' : 'fail',
  })
  const fails = packageFails(facts, ctx.packageName)
  const fail = fails.length > 0 ? fails[fails.length - 1] : null
  const failReason = fail ? String(fail.fields['reason'] ?? '') : ''
  const failCode = fail ? String(fail.fields['code'] ?? '') : ''
  const failHostHash = fail ? String(fail.fields['hostCodeHash'] ?? '') : ''
  run.record({
    step: 'f3a 产品失败日志：reason/code（宿主原话在电话回包，不在日志事件）',
    what: 'update.install.fail 一行：reason=nonzero-exit、code=install-failed、hostCodeHash=none；pnpm 原话在电话回包 message（前面已断言）',
    expected: 'reason=nonzero-exit；code=install-failed；hostCodeHash=none',
    actual: 'reason=' + failReason + '；code=' + failCode + '；hostCodeHash=' + failHostHash,
    verdict: fail !== null && failReason === 'nonzero-exit' && failCode === INSTALL_FAIL_CODE && failHostHash === 'none' ? 'pass' : 'fail',
  })
}

/** F3-B：出口一宿主 runPlugin 永不 settle 且没有 terminate → 超时且如实说无法终止。 */
async function runF3TimeoutNoTerminate(ctx: Ctx): Promise<void> {
  const run = ctx.run
  const handle = await startHost(ctx, 'exit-one-hang', 'desktop', { installTimeoutMs: SHORT_TIMEOUT_MS })
  await recordEquivalentHostBoundary(ctx, handle, {
    subcase: 'B-timeout-no-terminate',
    installTimeoutMs: SHORT_TIMEOUT_MS,
    whyThisSubcase: 'runPlugin 返回永不 settle 的 done 且句柄没有 terminate：产品只能按 installTimeoutMs 判超时，并按能力分支如实说「未提供终止能力，可能仍在后台继续」',
  })
  const ui = handle.ui
  if (!ui) throw new Error('[f3b] 宿主没有 UI')
  await waitForCard(ui)
  await checkUntilInstallable(ui, ctx.slot)
  const marker = join(handle.profileDir, '.equiv-hang')
  await writeFile(marker, 'hang\n')
  await run.raw('f3b-hang-marker', { markerPath: marker.replace(/\\/g, '/'), installTimeoutMs: SHORT_TIMEOUT_MS })
  run.addNote('f3b 注入：profile 目录放 .equiv-hang，夹具 runPlugin 返回永不 settle 的 done 且无 terminate。')
  try {
    await clickInCard(ui, cardSelectorOf(ctx.slot.key), '.dsh-upd-ib button[data-action="install"]')
    const terminal = await waitForTerminalJob(handle.host, ctx.route, ctx.statusPhone, 120000)
    const outcome = terminal.outcome
    const job = jobFacts(outcome)
    const message = jobMessageOf(job)
    const jobState = String(job['state'] ?? '')
    const code = jobCodeOf(job)
    const elapsed = terminal.elapsedMs
    await run.raw('f3b-phone-status-terminal', {
      state: jobState,
      code,
      message,
      elapsedMs: elapsed,
      polls: terminal.polls,
      replyStatus: outcome.reply.status,
    })
    run.record({
      step: 'f3b 安装作业终态',
      what: '出口一宿主无 terminate、runPlugin 挂死：产品按 deadline 判超时失败',
      expected: 'state=failed；code=install-failed',
      actual: 'state=' + jobState + '；code=' + String(code) + '；message=' + message.slice(0, 700),
      verdict: jobState === 'failed' && code === INSTALL_FAIL_CODE ? 'pass' : 'fail',
    })
    run.record({
      step: 'f3b 超时文案逐字：未提供终止能力',
      what: '产品超时人话格按能力分支：无 terminate 时必须用常量原文（src/core/executor.ts:92）',
      expected: '含「' + SERVICE_TIMEOUT_NO_TERMINATE_DETAIL + '」',
      actual: message.slice(0, 900),
      verdict: message.indexOf(SERVICE_TIMEOUT_NO_TERMINATE_DETAIL) >= 0 ? 'pass' : 'fail',
    })
    run.record({
      step: 'f3b 不谎称已取消/已终止',
      what: '没有 terminate 能力时不得出现「已请求宿主取消/终止」「已终止子进程」等我们去做了的话术',
      expected: '不含「安装超时，已请求宿主取消」「安装超时，已请求宿主终止」「安装超时，已终止子进程」',
      actual: message.slice(0, 900),
      verdict: message.indexOf('安装超时，已请求宿主取消') < 0 && message.indexOf('安装超时，已请求宿主终止') < 0 && message.indexOf('安装超时，已终止子进程') < 0 ? 'pass' : 'fail',
    })
    const carrier = message.indexOf('dsh plugin --profile') >= 0 || message.indexOf('--registry=') >= 0
    run.record({
      step: 'f3b 超时失败不出现载体命令',
      what: '超时路径不补载体命令（契约）',
      expected: '不含 dsh plugin --profile/--registry=',
      actual: 'carrier=' + String(carrier),
      verdict: carrier ? 'fail' : 'pass',
    })
    run.record({
      step: 'f3b 确实按 deadline+宽限收尾',
      what: 'installTimeoutMs=' + String(SHORT_TIMEOUT_MS) + 'ms + 3s 宽限；不能秒回、也不能拖过 ' + String(20000) + 'ms',
      expected: '5000 ≤ elapsedMs ≤ 20000',
      actual: 'elapsedMs=' + String(elapsed),
      verdict: elapsed >= 5000 && elapsed <= 20000 ? 'pass' : 'fail',
    })
    // 面板独立轮询（pollMs=5000）：等它把超时失败刷新出来，而不是立刻读旧 DOM。
    const timeoutPanel = await tryWaitForPanelBanner(ui, ctx.slot, (state) => state.banner !== null && state.banner.kind === 'failed', 'f3b 超时失败横幅', 30000)
    const card = timeoutPanel.state ?? (await readCard(ui, ctx.slot))
    const bannerKind = card.banner ? card.banner.kind : null
    const cardText = card.text
    const honest = bannerKind === 'failed' && cardText.indexOf('已是最新') < 0 && cardText.indexOf('更新成功') < 0 && cardText.indexOf('已终止子进程') < 0
    run.record({
      step: 'f3b 超时失败后面板不撒谎',
      what: '超时失败后面板显示失败横幅；不出现「已是最新/更新成功」，也不谎称「已终止子进程」（无 terminate 能力）',
      expected: 'banner.kind=failed；不含「已是最新」「更新成功」「已终止子进程」',
      actual: 'banner=' + JSON.stringify(card.banner) + '；install=' + JSON.stringify(card.install) + '；waitError=' + String(timeoutPanel.error) + '；text=' + cardText.slice(0, 600),
      verdict: honest ? 'pass' : 'fail',
    })
    await capture(run, ui, {
      step: 'f3b-timeout-panel',
      what: '超时失败后的面板：失败横幅 + 无「已终止」误导',
      expected: 'banner.kind=failed；不含「已是最新」「更新成功」「已终止子进程」',
      actual: 'banner=' + JSON.stringify(card.banner) + '；install=' + JSON.stringify(card.install) + '；text=' + cardText.slice(0, 900),
      verdict: honest ? 'pass' : 'fail',
    })
    await sleep(1000)
    const diskAfter = await installedFixtureVersion({ homeDir: ctx.homeDir, profileName: ctx.profileName, packageName: ctx.packageName })
    run.record({
      step: 'f3b 超时后磁盘仍是基版',
      what: 'runPlugin 根本没跑（只是挂起），node_modules 版本不变',
      expected: ctx.baseVersion,
      actual: String(diskAfter),
      verdict: diskAfter === ctx.baseVersion ? 'pass' : 'fail',
    })
  } finally {
    await rm(marker, { force: true })
  }

  await stopHost(ctx, handle, 'after-timeout')
  const captures = await readEquivalentHostCaptures(ctx, 'exit-one-hang')
  await run.raw('f3b-equivalent-host-captures', {
    dir: join(run.layout.rawDir, 'equivalent-host-exit-one-hang').replace(/\\/g, '/'),
    captures: captureSummary(captures),
  })
  const hang = captures.find((item) => item.payload['phase'] === 'runPlugin') ?? null
  const hangArgs = hang && Array.isArray(hang.payload['args']) ? (hang.payload['args'] as unknown[]).map(String) : []
  const specToken = ctx.packageName + '@' + ctx.variantVersion
  run.record({
    step: 'f3b 宿主侧确实是「挂起且无 terminate」形态',
    what: 'runPlugin 采集 mode=hang-no-terminate，参数含 add/包@变体/--registry；且没有任何 cancel/terminate 采集',
    expected: 'mode=hang-no-terminate；args 含 add 与 ' + specToken + '；无 cancel 采集',
    actual: 'mode=' + String(hang ? hang.payload['mode'] : null) + '；args=' + JSON.stringify(hangArgs).slice(0, 500) + '；hasCancel=' + String(hasCancelCapture(captures)),
    verdict: hang !== null && hang.payload['mode'] === 'hang-no-terminate' && hangArgs.indexOf('add') >= 0 && hangArgs.indexOf(specToken) >= 0 && !hasCancelCapture(captures) ? 'pass' : 'fail',
  })

  const facts = await readLogFacts(ctx)
  await run.raw('f3b-install-log-facts', {
    execs: facts.execs.map(execLine),
    fails: facts.fails.map(execLine),
    requests: packageRequests(facts, ctx.packageName).map(execLine),
  })
  await recordExecAssertions(run, facts, ctx.packageName, 'f3b', 'desktop-service')
  const execs = facts.execs.filter((event) => isPackageEvent(event, ctx.packageName))
  const lastExec = execs.length > 0 ? execs[execs.length - 1] : null
  const execRoute = lastExec ? String(lastExec.fields['route'] ?? '') : ''
  const execOk = lastExec ? lastExec.fields['ok'] : null
  run.record({
    step: 'f3b 产品失败日志：路线与 ok',
    what: 'update.install.exec 记录 route=desktop-service、ok=false',
    expected: 'route=desktop-service；ok=false',
    actual: 'route=' + execRoute + '；ok=' + String(execOk),
    verdict: execRoute === 'desktop-service' && execOk === false ? 'pass' : 'fail',
  })
  const fails = packageFails(facts, ctx.packageName)
  const fail = fails.length > 0 ? fails[fails.length - 1] : null
  const failReason = fail ? String(fail.fields['reason'] ?? '') : ''
  const failCode = fail ? String(fail.fields['code'] ?? '') : ''
  run.record({
    step: 'f3b 产品失败日志：reason=timeout（诚实文案在电话回包，不在日志事件）',
    what: 'update.install.fail 一行：reason=timeout、code=install-failed；「未提供终止能力」原文在作业 message（上一格已断言）',
    expected: 'reason=timeout；code=install-failed',
    actual: 'reason=' + failReason + '；code=' + failCode,
    verdict: fail !== null && failReason === 'timeout' && failCode === INSTALL_FAIL_CODE ? 'pass' : 'fail',
  })
}

/** G8：出口二管理器没有 cancelInstall → 超时失败，但后台安装真的落地。 */
async function runG8(ctx: Ctx): Promise<void> {
  const run = ctx.run
  const handle = await startHost(ctx, 'manager-no-cancel', 'desktop-manager', { installTimeoutMs: SHORT_TIMEOUT_MS, delayMs: MANAGER_DELAY_MS })
  await recordEquivalentHostBoundary(ctx, handle, {
    subcase: 'timeout-no-cancelInstall',
    installTimeoutMs: SHORT_TIMEOUT_MS,
    managerDelayMs: MANAGER_DELAY_MS,
    runningVersionInjected: ctx.baseVersion,
    whyThisSubcase: '等效 pluginManager 故意没有 cancelInstall（模板 equivalentPluginManager）；installBundle 先 delay ' + String(MANAGER_DELAY_MS) + 'ms 再真跑 CLI，产品 ' + String(SHORT_TIMEOUT_MS) + 'ms deadline 到点只能报「未提供取消能力」',
    whyRunningVersionInjected: '官方桌面宿主报「已加载代码」的版本，不拿磁盘 package.json 冒充；模板 desktop-manager readerOverrides 因此注入 runningVersion=' + ctx.baseVersion + '（当前加载的 host half 版本）。缺这格时 #245 的失败结算会以为目标版本已在跑，面板会在宿主仍跑旧版时说「已是最新」（#272-i2 的缺口）',
  })
  await run.raw('g8-equivalent-manager-methods', {
    methods: ['installBundle', 'removeBundle', 'listBundles', 'setBundleEnabled'],
    cancelInstall: false,
    source: 'selftest/fixtures/templates/integrator/integrator-host-half-template.ts（equivalentPluginManager）',
    note: '模板故意不提供 cancelInstall；产品据此走「宿主未提供取消能力」文案分支',
  })
  const ui = handle.ui
  if (!ui) throw new Error('[g8] 宿主没有 UI')
  await waitForCard(ui)
  await checkUntilInstallable(ui, ctx.slot)
  await clickInCard(ui, cardSelectorOf(ctx.slot.key), '.dsh-upd-ib button[data-action="install"]')
  const terminal = await waitForTerminalJob(handle.host, ctx.route, ctx.statusPhone, 120000)
  const outcome = terminal.outcome
  const job = jobFacts(outcome)
  const message = jobMessageOf(job)
  const jobState = String(job['state'] ?? '')
  const code = jobCodeOf(job)
  const elapsed = terminal.elapsedMs
  await run.raw('g8-phone-status-terminal', { state: jobState, code, message, elapsedMs: elapsed, polls: terminal.polls, replyStatus: outcome.reply.status })
  run.record({
    step: 'g8 安装作业终态（产品以为失败）',
    what: '等效桌面管理器无 cancelInstall、installBundle 迟迟不 resolve：产品按 deadline 判超时失败',
    expected: 'state=failed；code=install-failed',
    actual: 'state=' + jobState + '；code=' + String(code) + '；message=' + message.slice(0, 700),
    verdict: jobState === 'failed' && code === INSTALL_FAIL_CODE ? 'pass' : 'fail',
  })
  run.record({
    step: 'g8 超时文案逐字：未提供取消能力',
    what: '产品管理器超时人话格按能力分支：无 cancelInstall 时必须用常量原文（src/core/executor.ts:48）',
    expected: '含「' + MANAGER_TIMEOUT_NO_CANCEL_DETAIL + '」',
    actual: message.slice(0, 900),
    verdict: message.indexOf(MANAGER_TIMEOUT_NO_CANCEL_DETAIL) >= 0 ? 'pass' : 'fail',
  })
  run.record({
    step: 'g8 不谎称已取消/已终止',
    what: '没有 cancelInstall 时不得出现「安装超时，已请求宿主取消/终止」等我们去做了的话术',
    expected: '不含「安装超时，已请求宿主取消」「安装超时，已请求宿主终止」',
    actual: message.slice(0, 900),
    verdict: message.indexOf('安装超时，已请求宿主取消') < 0 && message.indexOf('安装超时，已请求宿主终止') < 0 ? 'pass' : 'fail',
  })
  run.record({
    step: 'g8 确实按 deadline+宽限收尾',
    what: 'installTimeoutMs=' + String(SHORT_TIMEOUT_MS) + 'ms + 3s 宽限；5000~25000ms',
    expected: '5000 ≤ elapsedMs ≤ 25000',
    actual: 'elapsedMs=' + String(elapsed),
    verdict: elapsed >= 5000 && elapsed <= 25000 ? 'pass' : 'fail',
  })
  // 面板独立轮询（pollMs=5000）：等它把管理器超时失败刷新出来；此刻宿主后台还在 delay/装。
  const timeoutPanel = await tryWaitForPanelBanner(ui, ctx.slot, (state) => state.banner !== null && state.banner.kind === 'failed', 'g8 管理器超时失败横幅', 30000)
  const card = timeoutPanel.state ?? (await readCard(ui, ctx.slot))
  const honest = card.banner !== null && card.banner.kind === 'failed' && card.text.indexOf('已是最新') < 0 && card.text.indexOf('更新成功') < 0
  run.record({
    step: 'g8 超时失败后面板不撒谎',
    what: '管理器超时失败后面板显示失败横幅，不出现「已是最新 / 更新成功」（产品确实不知道后台会成功）',
    expected: 'banner.kind=failed；不含「已是最新」「更新成功」',
    actual: 'banner=' + JSON.stringify(card.banner) + '；waitError=' + String(timeoutPanel.error) + '；text=' + card.text.slice(0, 600),
    verdict: honest ? 'pass' : 'fail',
  })
  await capture(run, ui, {
    step: 'g8-timeout-panel',
    what: '管理器超时失败后的面板（此刻后台其实还在装）',
    expected: 'banner.kind=failed；卡片不出现「已是最新 / 更新成功」',
    actual: 'banner=' + JSON.stringify(card.banner) + '；text=' + card.text.slice(0, 900),
    verdict: honest ? 'pass' : 'fail',
  })

  const statusNow = await callPhone(handle.host, ctx.route, ctx.statusPhone, {})
  const statusJob = jobFacts(statusNow)
  run.record({
    step: 'g8 宿主仍活着、作业仍报失败',
    what: '超时失败后宿主进程与产品服务仍可用（status 电话 200），作业状态仍 failed（产品不知道后台会成功）',
    expected: 'status=200；job.state=failed',
    actual: 'status=' + String(statusNow.reply.status) + '；job.state=' + String(statusJob['state']),
    verdict: statusNow.reply.status === 200 && String(statusJob['state'] ?? '') === 'failed' ? 'pass' : 'fail',
  })

  const diskAfter = await waitDiskVersion(ctx, ctx.variantVersion, 180000)
  run.record({
    step: 'g8 超时失败但后台真把变体装上了',
    what: 'installBundle 的 delay 结束后真跑 CLI：产品已判失败，磁盘 node_modules 却真的变成变体版',
    expected: ctx.packageName + '@' + ctx.variantVersion,
    actual: String(diskAfter),
    verdict: diskAfter === ctx.variantVersion ? 'pass' : 'fail',
  })
  const afterPanel = await tryWaitForPanelBanner(ui, ctx.slot, (state) => state.banner !== null && state.banner.kind === 'failed', 'g8 后台装完后仍失败横幅', 30000)
  const cardAfter = afterPanel.state ?? (await readCard(ui, ctx.slot))
  const honestAfter = cardAfter.banner !== null && cardAfter.banner.kind === 'failed' && cardAfter.text.indexOf('已是最新') < 0
  run.record({
    step: 'g8 后台装完后产品仍报失败',
    what: '磁盘已是变体版，但产品作业仍 failed（它真的不知道后台装完了；面板不谎称成功）',
    expected: 'banner.kind=failed；不含「已是最新」',
    actual: 'banner=' + JSON.stringify(cardAfter.banner) + '；waitError=' + String(afterPanel.error) + '；text=' + cardAfter.text.slice(0, 600),
    verdict: honestAfter ? 'pass' : 'fail',
  })
  await capture(run, ui, {
    step: 'g8-disk-updated-panel-still-failed',
    what: '磁盘已变体版但产品仍显示失败（「后台继续」的诚实文案与事实一致）',
    expected: 'banner.kind=failed；卡片不出现「已是最新」（产品没刷新到成功）',
    actual: 'banner=' + JSON.stringify(cardAfter.banner) + '；text=' + cardAfter.text.slice(0, 900),
    verdict: honestAfter ? 'pass' : 'fail',
  })

  await stopHost(ctx, handle, 'after-timeout-install')
  const captures = await readEquivalentHostCaptures(ctx, 'manager-no-cancel')
  await run.raw('g8-equivalent-host-captures', {
    dir: join(run.layout.rawDir, 'equivalent-host-manager-no-cancel').replace(/\\/g, '/'),
    captures: captureSummary(captures),
  })
  const request = captures.find((item) => item.payload['phase'] === 'installBundle.request') ?? null
  const results = captures.filter((item) => item.payload['phase'] === 'installBundle.result')
  const result = results.length > 0 ? results[results.length - 1] : null
  const clis = captures.filter((item) => item.payload['phase'] === 'cli')
  const lastCli = clis.length > 0 ? clis[clis.length - 1] : null
  const requestOptions = request && request.payload['options'] && typeof request.payload['options'] === 'object' ? (request.payload['options'] as Record<string, any>) : null
  const requestRegistry = requestOptions ? requestOptions['registry'] : null
  const specToken = ctx.packageName + '@' + ctx.variantVersion
  run.record({
    step: 'g8 管理器侧收到真安装请求（带 registry 透传）',
    what: 'installBundle.request：packageSpec=包@变体；options.registry=本 run 的 https 源；无 cancel 调用',
    expected: 'packageSpec=' + specToken + '；registry=' + ctx.registryUrl + '；hasCancel=false',
    actual: 'packageSpec=' + String(request ? request.payload['packageSpec'] : null) + '；registry=' + String(requestRegistry) + '；hasCancel=' + String(hasCancelCapture(captures)),
    verdict: request !== null && request.payload['packageSpec'] === specToken && normalizeUrl(requestRegistry) === normalizeUrl(ctx.registryUrl) && !hasCancelCapture(captures) ? 'pass' : 'fail',
  })
  run.record({
    step: 'g8 后台 CLI 真跑且成功、installBundle 报 applied',
    what: 'delay 之后模板真 spawn CLI（exitCode=0），manager 回 application=applied（产品早已不等它）',
    expected: 'cli.exitCode=0；result.application=applied；result.exitCode=0',
    actual: 'cliExit=' + String(lastCli ? lastCli.payload['exitCode'] : null) + '；result=' + JSON.stringify(result ? result.payload : null).slice(0, 500),
    verdict: lastCli !== null && lastCli.payload['exitCode'] === 0 && result !== null && result.payload['application'] === 'applied' && result.payload['exitCode'] === 0 ? 'pass' : 'fail',
  })

  // 重启后运行代码真换版（后台那次安装真的生效）。
  const restarted = await startHost(ctx, 'manager-no-cancel-restarted', 'desktop-manager', { installTimeoutMs: INSTALL_TIMEOUT_MS })
  const ui2 = restarted.ui
  if (!ui2) throw new Error('[g8] 重启宿主没有 UI')
  await waitForCard(ui2)
  const expectedTags = fixtureBuildTagsOf(ctx.slot, ctx.variantVersion as '0.0.2', ctx.run.scenario.variants[0].effect)
  const tags = await waitForBuildTags(ui2, ctx.slot, { clientTag: expectedTags.clientTag, hostTag: expectedTags.hostTag })
  await capture(run, ui2, {
    step: 'g8-after-restart',
    what: '重启后构建标记：后台那次「产品以为失败」的安装确实换了运行代码',
    expected: 'client=' + expectedTags.clientTag + '；host=' + expectedTags.hostTag,
    actual: 'client=' + String(tags.clientTag) + '；host=' + String(tags.hostTag) + '；title=' + String(tags.title),
    verdict: tags.clientTag === expectedTags.clientTag && tags.hostTag === expectedTags.hostTag ? 'pass' : 'fail',
  })
  await stopHost(ctx, restarted, 'after-restart')

  const facts = await readLogFacts(ctx)
  await run.raw('g8-install-log-facts', {
    execs: facts.execs.map(execLine),
    fails: facts.fails.map(execLine),
    requests: packageRequests(facts, ctx.packageName).map(execLine),
  })
  const execs = facts.execs.filter((event) => isPackageEvent(event, ctx.packageName))
  const execRoute = execs.length > 0 ? String(execs[execs.length - 1].fields['route'] ?? '') : ''
  const execOk = execs.length > 0 ? execs[execs.length - 1].fields['ok'] : null
  run.record({
    step: 'g8 产品失败日志：路线 desktop-manager + ok=false',
    what: 'update.install.exec 记录 route=desktop-manager、ok=false（超时失败）',
    expected: 'route=desktop-manager；ok=false',
    actual: 'route=' + execRoute + '；ok=' + String(execOk),
    verdict: execRoute === 'desktop-manager' && execOk === false ? 'pass' : 'fail',
  })
  const fails = packageFails(facts, ctx.packageName)
  const fail = fails.length > 0 ? fails[fails.length - 1] : null
  const failReason = fail ? String(fail.fields['reason'] ?? '') : ''
  const failCode = fail ? String(fail.fields['code'] ?? '') : ''
  const failDetail = fail ? String(fail.fields['detail'] ?? '') : ''
  run.record({
    step: 'g8 产品失败日志：reason=timeout',
    what: 'update.install.fail：reason=timeout、code=install-failed（失败事件不带 detail，诚实文案在电话回包，已由上一条断言覆盖）',
    expected: 'reason=timeout；code=install-failed',
    actual: 'reason=' + failReason + '；code=' + failCode + '；detail=' + failDetail.slice(0, 700),
    verdict: fail !== null && failReason === 'timeout' && failCode === INSTALL_FAIL_CODE ? 'pass' : 'fail',
  })
}

/**
 * 关闭宿主内建 HMR（profile patch，宿主文档化配置入口，不是产品后门）。
 * 为什么需要：dsh web 宿主 HMR 在插件包写盘后会热重载新代码（run 284-20261103T182639 日志：
 * update.install.verify restart-required 后 ~280ms 出现第二次 update.wire.ready），
 * 「磁盘已新版、进程仍跑旧版」的待重启状态只存在毫秒级。关掉 HMR（base 组合包的 hmr 条目）
 * 才能稳定验证这个非 HMR 宿主的真实状态；不注入 runningVersion 以外的产品内部状态。
 */
export function applyHmrPatch(before: string): { readonly after: string; readonly changed: boolean } {
  const already = /^- id:\s*hmr\s*$/m.test(before)
  const block = [
    '# [selftest #284 i4] 关闭宿主内建 HMR：让「新版本已写盘、进程仍跑旧版」的待重启状态稳定可验证。',
    '# 这是宿主文档化的 profile patch 入口（@deepseek-ai/dsh-hmr README「使用本包」）；只停用宿主热重载，',
    '# 不注入产品内部状态，安装仍由真 CLI 落真磁盘。',
    '- id: hmr',
    '  disabled: true',
    '',
  ].join('\n')
  const commentsOnly = before
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  const emptyArray = commentsOnly.length === 1 && commentsOnly[0].trim() === '[]'
  const after = already ? before : emptyArray ? before.replace(/\[\]\s*$/, block) : before.replace(/\s*$/, '') + '\n' + block
  return { after, changed: !already }
}

async function disableHostHmr(ctx: Ctx): Promise<void> {
  const patchPath = join(ctx.homeDir, 'profiles', PROFILE_NAME, 'cordis.patch.yml')
  const before = await readFile(patchPath, 'utf8')
  const patched = applyHmrPatch(before)
  const after = patched.after
  if (patched.changed) await writeFile(patchPath, after)
  await ctx.run.raw('i4-hmr-disabled', {
    path: patchPath.replace(/\\/g, '/'),
    changed: patched.changed,
    before,
    after,
    why: 'HMR 会在装盘后热重载新插件代码，使 runningVersion 与磁盘版相等，待重启分支只存在毫秒级；关 HMR 是宿主文档化配置，用来验证无 HMR 宿主的真实待重启状态。',
  })
  ctx.run.addNote('i4 宿主配置：profile patch 关闭 base 组合包的 hmr 条目（HMR 会在装盘后热重载插件，掩盖待重启状态）。patch 原文见 raw/i4-hmr-disabled。')
}

/** 插件电话桥不可用判定：未匹配 POST 在宿主上可能回 404 或 405；两者都证明桥不存在（200=桥存在）。 */
export function bridgeGoneOf(status: number | null): boolean {
  return status === 404 || status === 405
}

/** I4：已写盘未登记的待重启面板真相 + 重启后运行版权威。 */
async function runI4(ctx: Ctx): Promise<void> {
  const run = ctx.run
  await disableHostHmr(ctx)
  const gen1 = await startHost(ctx, 'i4-pending-restart', 'reader-version', { installTimeoutMs: INSTALL_TIMEOUT_MS })
  await recordEquivalentHostBoundary(ctx, gen1, {
    subcase: 'pending-restart/unregistered/running-version',
    runningVersionInjected: ctx.baseVersion,
    whyThisSubcase: '真实 web 宿主（cli 路由）里把「当前运行版本」注入成基版 ' + ctx.baseVersion + '：模拟「新版本已写盘、进程还跑旧版」；真 CLI 安装落真磁盘',
  })
  const ui = gen1.ui
  if (!ui) throw new Error('[i4] 宿主没有 UI')
  await waitForCard(ui)
  const before = await callPhone(gen1.host, ctx.route, ctx.statusPhone, {})
  await run.raw('i4-status-before', { replyStatus: before.reply.status, snapshot: before.snapshot })
  const installed = await installViaUi(ctx, gen1)
  const job = installed.job
  const jobState = String(job['state'] ?? '')
  await run.raw('i4-install-job', { state: jobState, code: jobCodeOf(job), message: jobMessageOf(job).slice(0, 900), elapsedMs: installed.terminalElapsedMs })
  run.record({
    step: 'i4 安装作业终态',
    what: 'cli 路由真 CLI 安装变体后产品给的作业终态',
    expected: 'completed 或 restart-required；code=null',
    actual: 'state=' + jobState + '；code=' + String(jobCodeOf(job)) + '；message=' + jobMessageOf(job).slice(0, 700),
    verdict: (jobState === 'completed' || jobState === 'restart-required') && jobCodeOf(job) === null ? 'pass' : 'fail',
  })
  const diskAfter = await waitDiskVersion(ctx, ctx.variantVersion)
  run.record({
    step: 'i4 磁盘版本（安装后、未重启）',
    what: '真 CLI 安装后 profile node_modules 里的实际版本',
    expected: ctx.variantVersion,
    actual: String(diskAfter),
    verdict: diskAfter === ctx.variantVersion ? 'pass' : 'fail',
  })

  // 只认 restart 横幅（kind=restart）；「有新版本可安装」的 update 横幅也含「新版本」字样，
  // 拿标题子串等会把安装前的旧横幅当新的，所以这里必须按 kind + 重启指引原文等。
  const banner1 = await waitForPanelBanner(
    ui,
    ctx.slot,
    (state) => state.banner !== null && state.banner.kind === 'restart' && state.banner.title.indexOf('重启宿主后生效') >= 0,
    '安装后出现待重启横幅',
  )
  const b1 = banner1.banner
  const title1 = b1 ? b1.title : ''
  const sub1 = b1 ? b1.sub : ''
  const action1 = b1 ? b1.action : ''
  const kind1 = b1 ? b1.kind : null
  const expectedTitle1 = '新版本 ' + ctx.variantVersion + ' 已安装，重启宿主后生效。'
  const expectedAction1 = '重启宿主以加载新版本；此为正常状态，非安装失败'
  // restart 横幅没有按钮：文案落在 sub；action 只在有按钮的场景才有值。
  const shown1 = sub1 || action1
  await capture(run, ui, {
    step: 'i4-pending-restart-banner',
    what: '已写盘未重启的面板横幅（登记在册）：待重启文案 + 非安装失败',
    expected: 'banner.kind=restart；title=「' + expectedTitle1 + '」；sub=「' + expectedAction1 + '」（restart 横幅没有 seal 徽标，不能拿空 seal 判失败）',
    actual: 'banner=' + JSON.stringify(b1) + '；seal=' + banner1.seal.slice(0, 300),
    verdict: kind1 === 'restart' && title1 === expectedTitle1 && shown1 === expectedAction1 ? 'pass' : 'fail',
  })
  const after = await callPhone(gen1.host, ctx.route, ctx.statusPhone, {})
  const snap1 = after.snapshot ?? {}
  const running1 = String(snap1['runningVersion'] ?? '')
  const installed1 = String(snap1['installedVersion'] ?? '')
  const blocked1 = snap1['blockedReason'] ?? null
  await run.raw('i4-status-after-install', { replyStatus: after.reply.status, snapshot: after.snapshot })
  run.record({
    step: 'i4 status 电话：运行版 vs 磁盘版 = 待重启',
    what: 'runner 不是「安装即成功」：runningVersion 仍基版、installedVersion 变体版、blockedReason=pending-restart',
    expected: 'runningVersion=' + ctx.baseVersion + '；installedVersion=' + ctx.variantVersion + '；blockedReason=pending-restart',
    actual: 'runningVersion=' + running1 + '；installedVersion=' + installed1 + '；blockedReason=' + String(blocked1),
    verdict: running1 === ctx.baseVersion && installed1 === ctx.variantVersion && blocked1 === 'pending-restart' ? 'pass' : 'fail',
  })

  const unregister = await rewriteEnrollment({ homeDir: ctx.homeDir, profileName: ctx.profileName, packageName: ctx.packageName, present: false })
  await run.raw('i4-enrollment-unregistered', {
    path: unregister.path.replace(/\\/g, '/'),
    mode: unregister.mode,
    bundlesBefore: unregister.bundlesBefore,
    bundlesAfter: unregister.bundlesAfter,
    changed: unregister.changed,
  })
  run.addNote('i4 注入：把包从 profile 的 dsh.profile.bundles 里摘掉（真实改 profile/package.json），模拟「未登记在使用范围清单」。')
  const expectedAction2 = '请先在宿主插件页选中该插件，再重启宿主以加载新版本。'
  await reopenUi(ui, gen1.host.url)
  await waitForCard(ui)
  // 面板 5s 轮询：必须等到「未登记」这一版文案（不能拿到重载前的已登记 restart 横幅就下结论）。
  const banner2 = await waitForPanelBanner(
    ui,
    ctx.slot,
    (state) => state.banner !== null && state.banner.kind === 'restart' && (state.banner.title.indexOf('未登记在使用范围清单') >= 0 || state.banner.sub === expectedAction2),
    '未登记待重启横幅',
  )
  const b2 = banner2.banner
  const title2 = b2 ? b2.title : ''
  const sub2 = b2 ? b2.sub : ''
  const action2 = b2 ? b2.action : ''
  const kind2 = b2 ? b2.kind : null
  const shown2 = sub2 || action2
  await capture(run, ui, {
    step: 'i4-unregistered-banner',
    what: '同一宿主里把包从在册摘掉后面板：未登记分支（重启也不会加载）',
    expected: 'banner.kind=restart；title 含「未登记在使用范围清单」与变体版；sub=「' + expectedAction2 + '」（同样无 seal 徽标）',
    actual: 'banner=' + JSON.stringify(b2) + '；seal=' + banner2.seal.slice(0, 300),
    verdict: kind2 === 'restart' && title2.indexOf('未登记在使用范围清单') >= 0 && title2.indexOf(ctx.variantVersion) >= 0 && shown2 === expectedAction2 ? 'pass' : 'fail',
  })
  await stopHost(ctx, gen1, 'after-unregistered-banner')

  // 未登记 + 重启：插件根本不加载（没有卡片、电话桥 404）。
  const gen2 = await startHost(ctx, 'i4-unregistered-restart', 'reader-version', { installTimeoutMs: INSTALL_TIMEOUT_MS })
  const ui2 = gen2.ui
  if (!ui2) throw new Error('[i4] 未登记重启宿主没有 UI')
  const deadline = Date.now() + 10000
  let seen = false
  while (Date.now() < deadline) {
    if (await cardPresence(ui2, ctx.slot)) {
      seen = true
      break
    }
    await sleep(POLL_MS)
  }
  const body2 = await ui2.page.innerText('body').catch(() => '')
  let bridge404: number | null = null
  let bridgeError: string | null = null
  try {
    const reply = await gen2.host.postPhone(ctx.route, ctx.statusPhone, {})
    bridge404 = reply.status
  } catch (error) {
    bridgeError = error instanceof Error ? error.message : String(error)
  }
  await run.raw('i4-unregistered-restart-probe', {
    cardSeen: seen,
    bodyHead: body2.slice(0, 1200),
    bridgeStatus: bridge404,
    bridgeError,
    snapshot: null,
  })
  // 电话桥不可用的观测：插件没加载就没有这座桥。本机宿主对未匹配的 POST 回 405
  // （Method Not Allowed），有的宿主形态回 404；两者都证明「桥不存在」，不能拿 200 当结论。
  const bridgeGone = bridgeGoneOf(bridge404)
  run.record({
    step: 'i4 未登记 + 重启：插件不加载',
    what: '重启后 10s 内卡片不出现（未被登记就不会被宿主加载），持卡插件电话桥不可用（404/405，不是 200）',
    expected: 'cardSeen=false；电话桥 status=404 或 405（本机宿主对未匹配 POST 回 405）',
    actual: 'cardSeen=' + String(seen) + '；bridgeStatus=' + String(bridge404) + '；bridgeError=' + String(bridgeError),
    verdict: seen === false && bridgeGone ? 'pass' : 'fail',
  })
  await capture(run, ui2, {
    step: 'i4-unregistered-not-loaded',
    what: '未登记重启后的页面（没有插件卡片/更新面板）',
    expected: '页面正常渲染、无夹具卡片',
    actual: 'cardSeen=' + String(seen) + '；bodyHead=' + body2.slice(0, 700),
    verdict: seen === false && body2.length > 0 ? 'pass' : 'fail',
  })
  await stopHost(ctx, gen2, 'after-unregistered-restart')

  const reenroll = await rewriteEnrollment({ homeDir: ctx.homeDir, profileName: ctx.profileName, packageName: ctx.packageName, present: true })
  await run.raw('i4-enrollment-restored', {
    path: reenroll.path.replace(/\\/g, '/'),
    mode: reenroll.mode,
    bundlesBefore: reenroll.bundlesBefore,
    bundlesAfter: reenroll.bundlesAfter,
    changed: reenroll.changed,
  })

  // 在册 + 重启：加载变体版、运行版本=磁盘版本，不再谎称待重启。
  const gen3 = await startHost(ctx, 'i4-loaded-variant', 'reader-version', { installTimeoutMs: INSTALL_TIMEOUT_MS })
  const ui3 = gen3.ui
  if (!ui3) throw new Error('[i4] 在册重启宿主没有 UI')
  await waitForCard(ui3)
  const expectedTags = fixtureBuildTagsOf(ctx.slot, ctx.variantVersion as '0.0.2', ctx.run.scenario.variants[0].effect)
  const tags = await waitForBuildTags(ui3, ctx.slot, { clientTag: expectedTags.clientTag, hostTag: expectedTags.hostTag })
  const status3 = await callPhone(gen3.host, ctx.route, ctx.statusPhone, {})
  const snap3 = status3.snapshot ?? {}
  const running3 = String(snap3['runningVersion'] ?? '')
  const installed3 = String(snap3['installedVersion'] ?? '')
  const blocked3 = snap3['blockedReason'] ?? null
  const card3 = await readCard(ui3, ctx.slot)
  await run.raw('i4-status-after-restart', { replyStatus: status3.reply.status, snapshot: status3.snapshot, tags, banner: card3.banner })
  run.record({
    step: 'i4 重启后运行代码真换版',
    what: '重启宿主后加载变体版：host half 构建标记换版（client+host 双标记）',
    expected: 'client=' + expectedTags.clientTag + '；host=' + expectedTags.hostTag,
    actual: 'client=' + String(tags.clientTag) + '；host=' + String(tags.hostTag) + '；title=' + String(tags.title),
    verdict: tags.clientTag === expectedTags.clientTag && tags.hostTag === expectedTags.hostTag ? 'pass' : 'fail',
  })
  run.record({
    step: 'i4 重启后运行版权威：runningVersion=installedVersion',
    what: '重启后 status 电话：runningVersion 跟磁盘一致、blockedReason 不再 pending-restart（不再谎称待重启）',
    expected: 'runningVersion=' + ctx.variantVersion + '；installedVersion=' + ctx.variantVersion + '；blockedReason=null',
    actual: 'runningVersion=' + running3 + '；installedVersion=' + installed3 + '；blockedReason=' + String(blocked3),
    verdict: running3 === ctx.variantVersion && installed3 === ctx.variantVersion && blocked3 === null ? 'pass' : 'fail',
  })
  const restartBanner = card3.banner !== null && card3.banner.kind === 'restart'
  await capture(run, ui3, {
    step: 'i4-loaded-after-restart',
    what: '在册 + 重启后的面板：待重启/未登记话术消失',
    expected: 'banner.kind≠restart；卡片不含「待重启」「未登记」',
    actual: 'banner=' + JSON.stringify(card3.banner) + '；text=' + card3.text.slice(0, 900),
    verdict: !restartBanner && card3.text.indexOf('待重启') < 0 && card3.text.indexOf('未登记') < 0 ? 'pass' : 'fail',
  })
  await stopHost(ctx, gen3, 'after-loaded-restart')

  const facts = await readLogFacts(ctx)
  await run.raw('i4-install-log-facts', {
    execs: facts.execs.map(execLine),
    fails: facts.fails.map(execLine),
    requests: packageRequests(facts, ctx.packageName).map(execLine),
  })
  const execs = facts.execs.filter((event) => isPackageEvent(event, ctx.packageName))
  const lastExec = execs.length > 0 ? execs[execs.length - 1] : null
  const execRoute = lastExec ? String(lastExec.fields['route'] ?? '') : ''
  const execOk = lastExec ? lastExec.fields['ok'] : null
  run.record({
    step: 'i4 产品路线：出口三 cli-process',
    what: '真实 web 宿主里产品日志 update.install.exec 的 route 必须是 cli-process、ok=true',
    expected: 'route=cli-process；ok=true',
    actual: 'route=' + execRoute + '；ok=' + String(execOk),
    verdict: execRoute === 'cli-process' && execOk === true ? 'pass' : 'fail',
  })
  const fails = packageFails(facts, ctx.packageName)
  run.record({
    step: 'i4 成功格不该有失败行',
    what: '产品日志 update.install.fail 里没有该包',
    expected: '0 条',
    actual: String(fails.length) + ' 条' + (fails.length > 0 ? '：' + execLine(fails[fails.length - 1]).slice(0, 500) : ''),
    verdict: fails.length === 0 ? 'pass' : 'fail',
  })
}

/** 跑一个 #284 恢复格。 */
/** run.json 自定义字段 equivalentHost：等效宿主说明（#284 brief 要求；schemaVersion 保持 1）。 */
export interface EquivalentHostManifestFacts {
  readonly what: string
  readonly why: string
  readonly documentedEntry: string
  readonly realParts: readonly string[]
  readonly simulatedParts: readonly string[]
  readonly nonEquivalence: readonly string[]
}

/** 按场景给出「等效了什么 / 什么是真的 / 什么没等效」。纯函数，单测可覆盖。 */
export function equivalentHostFactsOf(mode: RecoveryMode): EquivalentHostManifestFacts {
  const common = {
    why: '本机没有第三方 Desktop、也没有能稳定停在与产品内部状态相反的 web 宿主：按 #284 用户要求，用产品文档化集成方入口构造等效宿主，让产品代码走真实路径、断言真状态，绝不假回包。',
    documentedEntry: 'README「测试用集成方」deps.readerOverrides → host/factory.ts createHostUpdate；安装一律真 CLI/真 registry/真 tarball 落盘。',
  }
  if (mode === 'f2' || mode === 'f3' || mode === 'can-red') {
    const failure = mode === 'f3'
    return {
      what: failure
        ? '出口一（第三方 Desktop）失败格：desktopProfiles/desktopPnpm 等效宿主 + registry tarball 404 + runPlugin 无 terminate 挂起'
        : mode === 'can-red'
          ? '出口一成功格 + can-red 故障注入（stale-variant：清单 0.0.2、构建内容仍是 0.0.1）'
          : '出口一（第三方 Desktop）成功格：desktopProfiles/desktopPnpm 等效宿主',
      why: common.why,
      documentedEntry: common.documentedEntry,
      realParts: [
        '产品 src/host/environment.ts 路由判定 → environmentKind=desktop',
        '产品 src/core/executor.ts runDesktopService 真实执行路径（含 timeout/terminate 分支）',
        'runPlugin 由夹具模板 spawn 官方发行包真 CLI 装 tarball，真 registry、真 pnpm、真磁盘',
        '电话回包/面板/日志 update.install.exec|fail 全部来自真机',
        failure ? 'registry 下架用真 tarball 删除（元数据不变）制造 404' : '真 UI 点击 check/install',
      ],
      simulatedParts: [
        '宿主进程内的 desktopProfiles / desktopPnpm 服务对象由夹具模板（真 web 宿主内）实现，不等于第三方 Desktop 发行包自带实现',
        failure ? 'runPlugin 的「挂起且无 terminate」模式由夹具模板等效（targetDir/.equiv-hang）' : 'runPlugin 的 terminate 能力由夹具模板提供（本场景成功路径未用到）',
      ],
      nonEquivalence: [
        '没有第三方 Desktop 宿主进程/其 UI 壳/CDP 页面；等效宿主里产品跑在普通 web 宿主进程中',
        '第三方 Desktop 发行包内部的 runPlugin 调度细节（并发/锁/进度）不在覆盖范围内',
      ],
    }
  }
  if (mode === 'g8') {
    return {
      what: '出口二（官方桌面 in-process 插件管理器）超时格：pluginManager 故意不提供 cancelInstall，installBundle 延迟后真装',
      why: common.why,
      documentedEntry: common.documentedEntry,
      realParts: [
        '产品 src/host/environment.ts 路由判定 → environmentKind=desktop-manager（profileName=desktop）',
        '产品 src/core/executor.ts runDesktopManager 真实执行路径（含 installTimeoutDetail 无取消分支）',
        'installBundle 延迟结束后由夹具模板 spawn 真 CLI 装 tarball 落真磁盘',
        '超时后面板/电话/日志全部来自真机',
      ],
      simulatedParts: [
        'pluginManager 服务对象由夹具模板实现，故意不提供 cancelInstall（官方桌面管理器在 HMR 宿主上通常提供），用来覆盖「宿主无取消能力」真实分支',
        'installBundle 的延迟由夹具模板注入（delayMs），真安装随后发生',
      ],
      nonEquivalence: [
        '不是官方桌面进程内管理器；官方桌面 already-installed 毫秒守卫、removeBundle/取消语义未在等效宿主上重现',
        '真实官方桌面进程无法安全构造「无 cancelInstall」实例（这就是原 known-red 的原因）',
      ],
    }
  }
  return {
    what: '出口三（普通 DSH 宿主 spawn CLI）待重启真相：runningVersion 由文档化 readerOverrides 注入，三宿主代真重启/真改在册',
    why: common.why + ' 另：web 宿主内建 HMR 会在装盘后热重载插件、把待重启窗口压到毫秒级；按 @deepseek-ai/dsh-hmr 文档化 profile patch 关闭 HMR 后，注入值=真实已加载代（基版），不是伪造。',
    documentedEntry: common.documentedEntry + ' 另：HMR 停用走宿主文档化 profile patch（cordis.patch.yml 的 - id: hmr / disabled: true）。',
    realParts: [
      '真 dsh web 宿主（普通宿主，非官方桌面）与真 CLI 子进程安装',
      '产品 src/host/environment.ts 路由判定 → cli-process（profile 名 t3eq≠desktop）',
      '真改 profile/package.json 的 dsh.profile.bundles 摘/恢复在册',
      '三次真实宿主重启（未登记不加载 / 恢复登记后加载变体）',
      '面板/电话/日志/磁盘全部真机',
    ],
    simulatedParts: [
      'runningVersion 由文档化 readerOverrides 注入（web 宿主本身不提供运行代码版本）；关 HMR 后注入值等于真实已加载的基版',
      'HMR 以宿主文档化 profile patch 停用（不是产品后门，不是注入产品内部状态）',
    ],
    nonEquivalence: [
      '不是官方桌面宿主；官方桌面的 already-installed/remove→install 两步不在本场景',
      '关 HMR 是宿主配置选择；真实普通宿主若开 HMR，待重启窗口会更短（本场景验证的是无 HMR 宿主的真实状态）',
    ],
  }
}

/** 在 recorder 落盘后把等效宿主说明补进 run.json；schemaVersion 仍为 1（自定义字段不破坏契约）。 */
async function attachEquivalentHostFacts(run: T3Run, mode: RecoveryMode): Promise<void> {
  const file = join(run.layout.root, 'run.json')
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  manifest['equivalentHost'] = equivalentHostFactsOf(mode)
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n')
}

export async function runKnownRedRecovery(options: RecoveryOptions): Promise<RunManifest> {
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
  run.addNote(
    '等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。',
  )
  let ctx: Ctx | null = null
  try {
    ctx = await prepareRun(run, options)
    if (options.mode === 'f2' || options.mode === 'can-red') await runF2(ctx)
    else if (options.mode === 'f3') await runF3(ctx)
    else if (options.mode === 'g8') await runG8(ctx)
    else await runI4(ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await run.raw('scenario-error', { mode: options.mode, message, stack: error instanceof Error ? error.stack : null })
    run.record({ step: 'scenario-error', what: '场景主流程按预期走完、不抛工具异常', expected: '无异常', actual: message, verdict: 'unknown' })
    run.addNote('场景抛异常：' + message)
  } finally {
    if (ctx) await cleanupContext(ctx)
  }
  const manifest = await run.close()
  await attachEquivalentHostFacts(run, options.mode)
  if (options.syncEvidence !== false) await copyRunEvidence(run.layout, options.worktree)
  return manifest
}
