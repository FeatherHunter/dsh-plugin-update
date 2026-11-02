/**
 * selftest/real-machine/scenarios/k-ui-states.ts —— T10（#274）组 K：全 UI 状态证据（通道 B / web 宿主）。
 *
 * 四个 mode 对应四条声明（can-red 复用 K1 声明）：
 *   - k1  k-single-panel-happy：单包面板 happy path —— 未安装（额外面板绑未安装的 C）/ 可更新 / 更新中 /
 *         待重启 / 重启后已了结，外加安装按钮五档中的 idle→update→busy→done 与 changelog 全要素
 *         （行内 markdown、裸 URL、BREAKING、yanked、版本节上限截断提示）与「入口」状态。
 *   - k2  k-single-panel-failure：坏 tarball（元数据/dist.integrity 不动）→ 失败面 + 最后手段 + 手工命令原文
 *         → 停宿主真跑手工命令 → 重启后落定；台账保留 failed 历史（真相优先）。
 *   - k3  k-batch-panel-states：三包批量面板 —— 初始 pending / 检查后 ready+台账 / 全部更新 installing /
 *         坏 B 隔离（1 个失败横幅 + 行 failed + 好行 done，无全批假成功）/ 恢复后行内重试 done / 重启后 current。
 *   - k4  k-batch-resume：批量更新中途杀宿主 → 第二代冻结自动续跑（autoResume:false）→ 续跑按钮与 notice →
 *         续跑完成；exactly-once（每包成功安装恰一次、台账三条终态、无重复/丢行）。
 *   - can-red：K1 流程 + 停 gen1 后改 run 私有 home 里已装夹具 lib/client.js 的「已是最新，无需更新。」文案
 *         （esbuild 输出为 \\uXXXX 转义），重启后对面板横幅做精确原文断言 ⇒ 唯一红点、run verdict=fail、exit=1。
 *
 * 真机纪律：
 *   - 通道 B（CLI 宿主）不 relaunch 官方桌面，安装窗可安全轮询 DOM/磁盘；
 *   - 每 run 私有 DSH_HOME（os-home/.dsh）+ 独立 profile + 随机端口 + 仓库外 verdaccio；
 *   - 每 run 私有 pnpm store（pnpm_config_store_dir 指向 run 目录），坏 tarball 不被全局缓存命中；
 *   - 读日志一律在停宿主之后（dsh-log 有 1000ms 防抖，进程被杀会丢尾行）；
 *   - 试错 run 传 --no-evidence-sync，证据只进 runtime 目录；定稿 run 才复制进仓库。
 *
 * 证据只来自真机观测（DOM / 磁盘 / 台账 state.json / 递归日志 / registry 回包），不编造。
 */
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DelayingRegistryProxy } from '../../fixtures/release/delaying-registry-proxy.ts'
import { startDelayingRegistryProxy } from '../../fixtures/release/delaying-registry-proxy.ts'
import type { FixtureSlot, FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'
import { FIXTURE_BASE_VERSION, FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_SLOT_C, FIXTURE_VARIANT_VERSION, fixtureBuildTagsOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import type { LogEventRecord } from '../runtime/log-evidence.ts'
import { captureLogFiles, readLogEvents } from '../runtime/log-evidence.ts'
import type { TarballCorruptionFault } from '../runtime/registry-faults.ts'
import { corruptPublishedTarball, restoreCorruptedTarball } from '../runtime/registry-faults.ts'
import { publishScenarioVariants } from '../runtime/scenario-runner.ts'
import type { RunManifest } from '../runtime/evidence.ts'
import { AUTH_REQUIRED_MARKER, loadPlaywright } from '../base-verify/web-ui.ts'
import type { PlaywrightBrowser, PlaywrightPage } from '../base-verify/web-ui.ts'
import { startCliHost } from '../host/cli-host.ts'
import type { CliHostSession } from '../host/cli-host.ts'
import { createWebProfileInHome, installedPluginDir } from '../host/isolated-profile.ts'
import { runDshCli } from '../host/dsh-cli.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { auditInstallFails, cardSelectorOf, clickSeatAction, copyRunEvidence, readBatchDiskFacts, readBatchSeat, readDiskSnapshot, waitForBatchSeat, waitForDiskVersions } from './batch-helpers.ts'
import type { BatchRowState, BatchSeatState, DiskSnapshot } from './batch-helpers.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'
import type { T3Run } from './t3-common.ts'
import { directoryExists, ensureDir, listFilesRecursive, sha256File } from '../../tooling/fs-utils.ts'
import { sleep, waitFor } from '../../tooling/process.ts'
import type { ManagedProcess } from '../../tooling/process.ts'

/** 组 K 的运行模式。 */
export type KUiMode = 'k1' | 'k2' | 'k3' | 'k4' | 'can-red'

/** 组 K 场景入参（与 T5 出口场景同形，mode 决定走哪一格）。 */
export interface KUiScenarioOptions {
  /** 试错 run 传 false：不把 run.json/index.md/raw/shots 复制进仓库证据目录（定稿 run 才入库）。默认 true。 */
  syncEvidence?: boolean
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: KUiMode
}

/** mode → 场景声明 id（can-red 复用 K1 声明，用 run note/raw 标记注入）。 */
const MODE_SCENARIO: Record<KUiMode, string> = {
  k1: 'k-single-panel-happy',
  k2: 'k-single-panel-failure',
  k3: 'k-batch-panel-states',
  k4: 'k-batch-resume',
  'can-red': 'k-single-panel-happy',
}

/** 通道 B 的 profile 名（不能是 desktop：产品对 desktop 有特殊路径）。 */
const PROFILE_NAME = 't10ui'
/** UI 视口：比默认 1280x900 高，卡片/面板 + changelog 一次入画。 */
const VIEWPORT = { width: 1280, height: 1500 }
/** 一次安装（含 pnpm 取包）的最长等待。 */
const INSTALL_TIMEOUT_MS = 300000
/** UI/面板状态轮询的最长等待。 */
const PANEL_TIMEOUT_MS = 120000
/** 轮询间隔。 */
const POLL_MS = 300
/** 台账成功终态（completed=已收尾 / restart-required=待重启收尾）。 */
const SUCCESS_STATES = ['completed', 'restart-required'] as const

/** 截图/断言的判定四态。 */
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

/** 单包面板 DOM 读数。 */
interface PanelState {
  present: boolean
  plugin: string | null
  banner: { kind: string | null; title: string; sub: string } | null
  errCode: string | null
  settled: string
  lastResort: { present: boolean; badge: string; status: string; reason: string; copyText: string } | null
  manual: { present: boolean; heading: string; code: string | null; neutral: string } | null
  strip: string[]
  changelog: {
    present: boolean
    heading: string
    versions: { version: string | null; title: string }[]
    yanked: string
    truncnote: string
    cats: (string | null)[]
    foldCats: (string | null)[]
    neutral: string
    mdCodes: string[]
    mdStrongs: string[]
    mdEms: string[]
    mdDels: string[]
    mdLinks: { text: string; href: string }[]
    breakingBadges: string[]
    hasScript: boolean
    text: string
  } | null
  actions: { action: string | null; text: string; disabled: boolean }[]
  progress: string
}

/** 入口（entry）读数。 */
interface EntryState {
  present: boolean
  variant: string | null
  state: string | null
  text: string
  note: string
}

/** 安装按钮读数。 */
interface InstallButtonState {
  present: boolean
  kind: string | null
  status: string
  sub: string
  buttons: { action: string | null; text: string; disabled: boolean }[]
  manualSummary: string
}

/** 批量面板额外读数（横幅 / 续跑区 / 回执）。 */
interface BatchExtras {
  present: boolean
  failed: { title: string; sub: string; list: string[]; rowline: string[] } | null
  restart: { title: string; sub: string; buttons: string[] } | null
  more: { resume: string; cancel: string; cancelConfirm: string } | null
  notice: string
  summary: string
  ledger: string
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
  readonly proxy: DelayingRegistryProxy | null
  ui: UiHandle | null
  stopped: boolean
}

/** 场景上下文（跨 gen 共享隔离环境）。 */
interface KContext {
  readonly run: T3Run
  readonly mode: KUiMode
  homeDir: string
  osHomeDir: string
  readonly profileName: string
  readonly registryUrl: string
  readonly gens: HostGen[]
  host: CliHostSession | null
  ui: UiHandle | null
}

/** 台账条目（state.json）。 */
interface LedgerEntry {
  file: string
  state: Record<string, unknown>
}

/** 取夹具 A 的批量目标（key a/b/c）。 */
function batchTargetOf(key: string): { key: string; title: string; packageName: string; prefix: string } {
  const batch = FIXTURE_SLOT_A.batch
  if (!batch) throw new Error('夹具 A 缺少批量绑定')
  const target = batch.targets.find((item) => item.key === key)
  if (!target) throw new Error('夹具 A 的批量目标表里没有 ' + key)
  return target
}

/** 台账里某个插件（packageName）的 state.json。 */
function ledgerOf(entries: readonly LedgerEntry[], packageName: string): LedgerEntry | null {
  return entries.find((entry) => entry.file.indexOf('/' + packageName + '/') >= 0) || null
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
      const tmpPath = join(tmpdir(), 'k-ui-adapter-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png')
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
    'var cl=q(".dsh-upd-changelog");' +
    'var wrap=q(".dsh-upd-changelog-wrap");' +
    'var changelog=(cl||wrap)?{present:!!cl,heading:wrap?txt(wrap.querySelector("div")):"",versions:qa(".dsh-upd-changelog-version").map(function(el){return {version:el.getAttribute("data-version"),title:txt(el)}}),yanked:txt(q(".dsh-upd-changelog-yanked")),truncnote:txt(q(".dsh-upd-changelog-truncnote")),cats:qa(".dsh-upd-changelog-cat").map(function(el){return el.getAttribute("data-cat")}),foldCats:qa(".dsh-upd-changelog-fold").map(function(el){return el.getAttribute("data-cat")}),neutral:txt(q(".dsh-upd-changelog-neutral")),mdCodes:qa(".dsh-upd-md-code").map(txt),mdStrongs:qa(".dsh-upd-md-strong").map(txt),mdEms:qa(".dsh-upd-md-em").map(txt),mdDels:qa(".dsh-upd-md-del").map(txt),mdLinks:qa(".dsh-upd-md-link").map(function(el){return {text:txt(el),href:el.getAttribute("href")||""}}),breakingBadges:qa(".dsh-upd-breaking-badge").map(txt),hasScript:cl?/<script/i.test(cl.innerHTML):false,text:txt(cl)}:null;' +
    'var actions=qa("button[data-action]").map(function(el){return {action:el.getAttribute("data-action"),text:txt(el),disabled:el.disabled===true||el.hasAttribute("disabled")}});' +
    'return {present:true,plugin:root.getAttribute("data-plugin"),banner:banner,errCode:txt(q(".dsh-upd-err code"))||null,settled:txt(settleEl),lastResort:lastResort,manual:manual,strip:qa(".dsh-upd-strip-v").map(txt),changelog:changelog,actions:actions,progress:txt(q(".dsh-upd-progtxt"))};' +
    '})()'
}

/** 入口读数脚本。 */
function entryScript(cardSelector: string): string {
  return '(function(){' +
    'var card=document.querySelector(' + JSON.stringify(cardSelector) + ');' +
    'if(!card)return {present:false};' +
    'var e=card.querySelector(".dsh-upd-entry");' +
    'if(!e)return {present:false};' +
    'function txt(el){return el?String(el.textContent||"").trim():""}' +
    'return {present:true,variant:e.getAttribute("data-variant"),state:e.getAttribute("data-state"),text:txt(e.querySelector("button")),note:txt(e.querySelector(".dsh-upd-entry-note"))};' +
    '})()'
}

/** 安装按钮读数脚本。 */
function installButtonScript(cardSelector: string): string {
  return '(function(){' +
    'var card=document.querySelector(' + JSON.stringify(cardSelector) + ');' +
    'if(!card)return {present:false};' +
    'var ib=card.querySelector(".dsh-upd-ib");' +
    'if(!ib)return {present:false};' +
    'function txt(el){return el?String(el.textContent||"").trim():""}' +
    'var st=ib.querySelector(".dsh-upd-ib-status");' +
    'var kind=null;' +
    'if(st){var matched=/(?:^|\\s)dsh-upd-ib-kind-([a-z-]+)/.exec(st.className);kind=matched?matched[1]:null}' +
    'var buttons=Array.prototype.slice.call(ib.querySelectorAll("button")).map(function(el){return {action:el.getAttribute("data-action"),text:txt(el),disabled:el.disabled===true||el.hasAttribute("disabled")}});' +
    'return {present:true,kind:kind,status:txt(st),sub:txt(ib.querySelector(".dsh-upd-ib-sub")),buttons:buttons,manualSummary:txt(ib.querySelector(".dsh-upd-ib-manual summary"))};' +
    '})()'
}

/** 批量面板额外读数脚本（横幅 / 续跑区 / 回执 / 总账 / 台账）。 */
function batchExtrasScript(cardSelector: string): string {
  return '(function(){' +
    'var card=document.querySelector(' + JSON.stringify(cardSelector) + ');' +
    'if(!card)return {present:false};' +
    'var panel=card.querySelector(".dsh-upd-batch");' +
    'if(!panel)return {present:false};' +
    'function txt(el){return el?String(el.textContent||"").trim():""}' +
    'function qa(scope,s){return Array.prototype.slice.call(scope.querySelectorAll(s))}' +
    'var fb=panel.querySelector(".dsh-upd-banner[data-kind=failed]");' +
    'var rb=panel.querySelector(".dsh-upd-banner[data-kind=restart]");' +
    'var more=panel.querySelector(".dsh-upd-batch-more");' +
    'var cancel=more?more.querySelector("[data-act=cancel]"):null;' +
    'return {present:true,failed:fb?{title:txt(fb.querySelector("strong")),sub:txt(fb.querySelector(".dsh-upd-banner-sub")),list:qa(fb,".dsh-upd-blist > *").map(txt),rowline:qa(fb,".dsh-upd-browline button").map(txt)}:null,restart:rb?{title:txt(rb.querySelector("strong")),sub:txt(rb.querySelector(".dsh-upd-banner-sub")),buttons:qa(rb,"button").map(txt)}:null,more:more?{resume:txt(more.querySelector("[data-act=resume]")),cancel:txt(cancel),cancelConfirm:cancel?(cancel.getAttribute("data-confirm")||""):""}:null,notice:txt(panel.querySelector(".dsh-upd-batch-notice")),summary:txt(panel.querySelector(".dsh-upd-batch-sum")),ledger:txt(panel.querySelector(".dsh-upd-batch-ledger"))};' +
    '})()'
}

/** 读单包面板；卡片/面板未挂载时返回 null。 */
async function readPanel(ui: UiHandle, cardSelector: string, pluginSelector: string): Promise<PanelState | null> {
  const state = await ui.page.evaluate<PanelState | null>(panelScript(cardSelector, pluginSelector)).catch(() => null)
  return state
}

/** 读入口。 */
async function readEntry(ui: UiHandle, cardSelector: string): Promise<EntryState> {
  return ui.page.evaluate<EntryState>(entryScript(cardSelector))
}

/** 读安装按钮。 */
async function readInstallButton(ui: UiHandle, cardSelector: string): Promise<InstallButtonState> {
  return ui.page.evaluate<InstallButtonState>(installButtonScript(cardSelector))
}

/** 读批量面板额外读数。 */
async function readBatchExtras(ui: UiHandle, cardSelector: string): Promise<BatchExtras> {
  return ui.page.evaluate<BatchExtras>(batchExtrasScript(cardSelector))
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

/** 轮询批量面板额外读数直到 predicate 成立。 */
async function waitForBatchExtras(ui: UiHandle, cardSelector: string, predicate: (extras: BatchExtras) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<BatchExtras> {
  const deadline = Date.now() + timeoutMs
  let last: BatchExtras | null = null
  while (Date.now() < deadline) {
    last = await readBatchExtras(ui, cardSelector)
    if (last.present && predicate(last)) return last
    await sleep(POLL_MS)
  }
  throw new Error('等待批量面板横幅超时（' + label + '）：last=' + JSON.stringify(last ? { failed: last.failed, restart: last.restart, more: last.more } : null))
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

/** 造/准备 run 的隔离环境：profile、pnpm store、SUT 校验、基版磁盘核对、变体发布。 */
async function prepareRun(run: T3Run, options: KUiScenarioOptions): Promise<KContext> {
  const fixtureEnv = run.fixtureEnv
  if (!fixtureEnv) throw new Error('K 场景必须有夹具环境（openT3Run 应带 withFixtures）')
  const osHomeDir = join(run.layout.root, 'os-home')
  const homeDir = join(osHomeDir, '.dsh')
  await ensureDir(osHomeDir)
  await ensureDir(homeDir)
  const storeDir = join(run.layout.root, 'pnpm-store')
  await ensureDir(storeDir)
  process.env['pnpm_config_store_dir'] = storeDir
  const ctx: KContext = { run, mode: options.mode, homeDir, osHomeDir, profileName: PROFILE_NAME, registryUrl: fixtureEnv.registry.baseUrl, gens: [], host: null, ui: null }
  await run.raw('isolation-facts', {
    osHomeDir,
    homeDir,
    profileName: PROFILE_NAME,
    pnpmStoreDir: storeDir,
    registryUrl: ctx.registryUrl,
    playwrightDir: process.env['DSH_VERIFY_PLAYWRIGHT'] || null,
    node: process.version,
    platform: process.platform,
  })
  createWebProfileInHome({ homeDir, profileName: PROFILE_NAME })
  const baseline = await run.publishBaseline()
  await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl: ctx.registryUrl })
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
async function startHostGen(ctx: KContext, label: string, options: { delayMs?: number; match?: 'pnpm-user-agent' | 'all'; withUi?: boolean } = {}): Promise<HostGen> {
  let registryUrl = ctx.registryUrl
  let proxy: DelayingRegistryProxy | null = null
  if (options.delayMs && options.delayMs > 0) {
    proxy = await startDelayingRegistryProxy({ upstreamBaseUrl: ctx.registryUrl, delayMs: options.delayMs, match: options.match ?? 'pnpm-user-agent' })
    ctx.run.registerPort(label + '-proxy', proxy.port)
    registryUrl = proxy.baseUrl
  }
  const host = await startCliHost({
    homeDir: ctx.homeDir,
    osHomeDir: ctx.osHomeDir,
    profileName: PROFILE_NAME,
    extraEnv: { DSH_SELFTEST_REGISTRY: registryUrl },
  })
  ctx.run.registerProcess(label + '-host', host.pid() ?? null)
  ctx.run.registerPort(label + '-host-port', host.port)
  const gen: HostGen = { index: ctx.gens.length, host, registryUrl, proxy, ui: null, stopped: false }
  ctx.gens.push(gen)
  await ctx.run.raw('host-launch-' + label, {
    label,
    urlMasked: host.url.replace(/token=[^&]+/, 'token=***'),
    port: host.port,
    bootMs: host.bootMs,
    registryUrl,
    proxyPort: proxy ? proxy.port : null,
    proxyDelayMs: options.delayMs ?? null,
    stdoutTail: host.stdout().slice(-1600),
    stderrTail: host.stderr().slice(-1600),
  })
  if (options.withUi !== false) {
    gen.ui = await openUi(host.url)
    ctx.run.addNote('宿主 ' + label + ' 已起：port=' + host.port + '，UI=' + gen.ui.label + '（registry=' + registryUrl + '）')
  }
  ctx.host = host
  ctx.ui = gen.ui
  return gen
}

/** 停一代宿主（UI → 宿主 → 延迟代理），并登记 raw。 */
async function stopHostGen(ctx: KContext, gen: HostGen, reason = 'stop'): Promise<void> {
  if (gen.stopped) return
  gen.stopped = true
  const port = gen.host.port
  const pid = gen.host.pid()
  if (gen.ui) {
    await gen.ui.close().catch(() => undefined)
    gen.ui = null
  }
  await gen.host.close().catch(() => undefined)
  let proxyRequests: number | null = null
  if (gen.proxy) {
    proxyRequests = gen.proxy.requests().length
    await gen.proxy.stop().catch(() => undefined)
  }
  if (ctx.host === gen.host) {
    ctx.host = null
    ctx.ui = null
  }
  await ctx.run.raw('host-stop-' + gen.index, { reason, gen: gen.index, port, pid: pid ?? null, registryUrl: gen.registryUrl, proxyRequests })
}

/** 收尾：停掉所有未停的宿主代，并在全部宿主停后统一收割日志。 */
async function cleanupContext(ctx: KContext): Promise<void> {
  for (const gen of ctx.gens) {
    if (!gen.stopped) await stopHostGen(ctx, gen, 'cleanup')
  }
  try {
    const capture = await captureLogFiles(ctx.run.recorder, ctx.homeDir)
    await ctx.run.raw('cleanup-log-files', { files: capture.snapshot.files, eventCount: capture.snapshot.events.length, truncations: capture.truncations.length })
  } catch (error) {
    ctx.run.addNote('日志收割失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

/** 读磁盘版本（按 packageName）。 */
async function diskVersions(ctx: KContext, packageNames: readonly string[]): Promise<Record<string, string | null>> {
  const snapshot: DiskSnapshot = await readDiskSnapshot({ homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageNames })
  return snapshot.versions
}

/** 等磁盘版本到位。 */
async function waitDiskVersions(ctx: KContext, expected: Record<string, string>, label: string): Promise<void> {
  await waitForDiskVersions({ homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageNames: Object.keys(expected) }, expected, { label, timeoutMs: INSTALL_TIMEOUT_MS })
}

/** 读全部台账 state.json。 */
async function ledgerStates(ctx: KContext): Promise<LedgerEntry[]> {
  const root = join(ctx.homeDir, 'updates')
  if (!(await directoryExists(root))) return []
  const files = (await listFilesRecursive(root)).filter((file) => file.endsWith('state.json')).sort()
  const entries: LedgerEntry[] = []
  for (const file of files) {
    const normalized = file.split('\\').join('/')
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      entries.push({ file: normalized, state: parsed })
    } catch {
      entries.push({ file: normalized, state: { corrupt: true } })
    }
  }
  return entries
}

/** 台账里某插件的记录（找不到 null）。 */
async function ledgerFor(ctx: KContext, packageName: string): Promise<LedgerEntry | null> {
  return ledgerOf(await ledgerStates(ctx), packageName)
}

/** 轮询台账直到某插件状态命中。 */
async function waitForLedger(ctx: KContext, packageName: string, wanted: readonly string[], label: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<LedgerEntry | null> {
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
async function readEvents(ctx: KContext): Promise<LogEventRecord[]> {
  const snapshot = await readLogEvents(ctx.homeDir)
  return snapshot.events
}

/** 按事件名筛。 */
function eventsNamed(events: readonly LogEventRecord[], name: string): LogEventRecord[] {
  return events.filter((event) => event.event === name)
}

/** 某插件（包名）的安装执行事件（fields.pluginId 或 source 命名空间匹配）。 */
function installExecsOf(events: readonly LogEventRecord[], packageName: string): LogEventRecord[] {
  return events.filter((event) => event.event === 'update.install.exec' && (String(event.fields['pluginId'] || '') === packageName || (event.source || '').startsWith(packageName + '/')))
}

/** 某插件的安装失败事件。 */
function installFailsOf(events: readonly LogEventRecord[], packageName: string): LogEventRecord[] {
  return events.filter((event) => event.event === 'update.install.fail' && (String(event.fields['pluginId'] || '') === packageName || (event.source || '').startsWith(packageName + '/')))
}

/** 成功 exec 计数。 */
function okExecCount(records: readonly LogEventRecord[]): number {
  return records.filter((record) => record.fields['ok'] === true).length
}

/** 把 LogEventRecord 转成 auditInstallFails 期待的 fact 形状。 */
function asAuditFacts(events: readonly LogEventRecord[]): { namespace: string; event: string; level: string | null; fields: Record<string, unknown> }[] {
  return events.map((event) => ({ namespace: (event.source || '').split('/')[0], event: event.event, level: event.level, fields: event.fields }))
}

/** 磁盘上的批量会话条目（<home>/update-queue/<scope>/fxa/batch.json）。 */
async function diskBatchEntries(ctx: KContext): Promise<{ key: string; phase: string; targetVersion: string | null; restartRequired: boolean; error: string | null }[]> {
  const facts = await readBatchDiskFacts(ctx.homeDir)
  const owners = facts.owners as Record<string, { batch: Record<string, unknown> | null }>
  const owner = owners['fxa'] || owners['fxb']
  const batch = owner ? owner.batch : null
  const entries = batch && Array.isArray(batch['entries']) ? (batch['entries'] as { key: string; phase: string; targetVersion?: string | null; restartRequired?: boolean; error?: string | null }[]) : []
  return entries.map((entry) => ({ key: entry.key, phase: entry.phase, targetVersion: entry.targetVersion ?? null, restartRequired: entry.restartRequired === true, error: entry.error ?? null }))
}

/** 等磁盘批量会话满足 predicate。 */
async function waitDiskBatch(ctx: KContext, predicate: (entries: { key: string; phase: string }[]) => boolean, label: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<{ key: string; phase: string; targetVersion: string | null; restartRequired: boolean; error: string | null }[]> {
  const deadline = Date.now() + timeoutMs
  let last: { key: string; phase: string }[] = []
  while (Date.now() < deadline) {
    const entries = await diskBatchEntries(ctx)
    last = entries.map((entry) => ({ key: entry.key, phase: entry.phase }))
    if (predicate(last)) return entries
    await sleep(POLL_MS)
  }
  ctx.run.addNote('等批量磁盘状态超时（' + label + '）：last=' + JSON.stringify(last))
  return diskBatchEntries(ctx)
}

/** 找批量行（面板读数）。 */
function rowOfSeat(seat: BatchSeatState, key: string): BatchRowState | null {
  return seat.panel.rows.find((row) => row.key === key) || null
}

/** 读卡片上的构建标记（clientTag/hostTag）。 */
async function readCardTags(ui: UiHandle, cardSelector: string): Promise<{ clientTag: string | null; hostTag: string | null }> {
  return ui.page.evaluate<{ clientTag: string | null; hostTag: string | null }>('(function(){' +
    'var card=document.querySelector(' + JSON.stringify(cardSelector) + ');' +
    'if(!card)return {clientTag:null,hostTag:null};' +
    'var host=card.querySelector("[data-fixture-host-tag]");' +
    'return {clientTag:card.getAttribute("data-build-tag"),hostTag:host?String(host.textContent||"").trim():null};' +
    '})()')
}

/** 等面板 changelog 出现某版本节。 */
async function waitForChangelog(ui: UiHandle, cardSelector: string, pluginSelector: string, version: string, timeoutMs = 60000): Promise<PanelState> {
  return waitForPanel(ui, cardSelector, pluginSelector, (state) => !!state.changelog && state.changelog.versions.some((item) => item.version === version), 'changelog 版本节 ' + version, timeoutMs)
}

/** 判断某元素当前是否可见（offsetHeight>0）。 */
async function elementVisible(ui: UiHandle, cardSelector: string, selector: string): Promise<boolean> {
  return ui.page.evaluate<boolean>('(function(){var card=document.querySelector(' + JSON.stringify(cardSelector) + ');if(!card)return false;var el=card.querySelector(' + JSON.stringify(selector) + ');return !!el && el.offsetHeight > 0})()')
}

/** K1：单包面板 happy path（未安装 / 可更新 / 更新中 / 待重启 / 重启后已了结 + changelog 全要素）。 */
async function runK1(ctx: KContext, options: KUiScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const packageA = FIXTURE_SLOT_A.packageName
  const packageC = FIXTURE_SLOT_C.packageName
  const cardA = cardSelectorOf('a')
  const panelA = '.dsh-upd[data-plugin="' + packageA + '"]'
  const panelC = '.dsh-upd[data-plugin="' + packageC + '"]'
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)

  const gen1 = await startHostGen(ctx, 'k1-gen1', { delayMs: 2500, match: 'pnpm-user-agent' })
  const ui1 = uiOf(gen1)
  await waitForBody(ui1, '夹具 A 本体', 'A 卡片挂载')
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null, 'A 面板初始')
  const cInitial = await waitForPanel(ui1, cardA, panelC, (state) => state.banner !== null, 'C 额外面板初始')
  const initial = (await readPanel(ui1, cardA, panelA)) as PanelState
  const entryInitial = await readEntry(ui1, cardA)
  const buttonInitial = await readInstallButton(ui1, cardA)
  const initialDone = initial.banner !== null && initial.banner.kind === 'done' && initial.banner.title === '已是最新，无需更新。'
  const initialEntryOk = entryInitial.present && entryInitial.variant === 'badge' && entryInitial.note.indexOf('已是最新') >= 0
  const initialOk = initialDone && cInitial.banner !== null && cInitial.banner.kind === 'idle' && cInitial.banner.title === '未安装' && initialEntryOk && buttonInitial.kind === 'done'
  await capture(ctx.run, ui1, {
    step: 'k1-10-initial',
    what: 'A 单包面板初始（未查更新）+ 额外面板绑未安装的 C + 安装按钮 + 入口',
    expected: 'A 横幅「已是最新，无需更新。」；C 横幅「未安装」+「检查更新」；安装按钮 done 档；入口 badge/已是最新',
    actual: 'A=' + JSON.stringify(initial.banner) + '；C=' + JSON.stringify(cInitial.banner) + '；按钮 kind=' + String(buttonInitial.kind) + '；入口=' + JSON.stringify({ variant: entryInitial.variant, state: entryInitial.state, note: entryInitial.note }),
    verdict: initialOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-11-panel-done', what: '已安装且未查更新时单包面板显示已了结', expected: 'banner.kind=done、标题「已是最新，无需更新。」', actual: JSON.stringify(initial.banner), ok: initialDone })
  rec({ step: 'k1-12-c-not-installed', what: '额外面板指向未安装的 C：显示未安装与检查动作', expected: 'banner.kind=idle、标题「未安装」、有 check 动作', actual: JSON.stringify(cInitial.banner) + '；actions=' + JSON.stringify(cInitial.actions.map((item) => item.action)), ok: cInitial.banner !== null && cInitial.banner.kind === 'idle' && cInitial.banner.title === '未安装' && cInitial.actions.some((item) => item.action === 'check') })
  rec({ step: 'k1-13-install-button-done', what: '安装按钮在已装且已了结时是 done 档', expected: 'kind=done', actual: String(buttonInitial.kind), ok: buttonInitial.kind === 'done' })
  rec({ step: 'k1-14-entry-idle', what: '单包入口初始态为 badge + 已是最新备注', expected: 'variant=badge、note 含「已是最新」', actual: JSON.stringify(entryInitial), ok: initialEntryOk })

  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  const updating = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', '可更新横幅')
  const withChangelog = await waitForChangelog(ui1, cardA, panelA, FIXTURE_VARIANT_VERSION)
  const entryUpdate = await readEntry(ui1, cardA)
  const buttonUpdate = await readInstallButton(ui1, cardA)
  const updateOk = updating.banner !== null && updating.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。' && updating.actions.some((item) => item.action === 'install')
  await capture(ctx.run, ui1, {
    step: 'k1-20-update',
    what: '点「检查更新」后：可更新横幅 + 安装动作 + 版本条 + 入口',
    expected: '横幅「有新版本 0.0.2 可安装（当前版本 0.0.1）。」、有 install 动作、入口 update 档',
    actual: JSON.stringify(updating.banner) + '；strip=' + JSON.stringify(updating.strip) + '；actions=' + JSON.stringify(updating.actions.map((item) => item.action)) + '；入口=' + JSON.stringify({ state: entryUpdate.state, text: entryUpdate.text }),
    verdict: updateOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-21-update-banner', what: '可更新横幅原文与动作', expected: '标题精确等于「有新版本 0.0.2 可安装（当前版本 0.0.1）。」且含 install', actual: JSON.stringify(updating.banner) + '；actions=' + JSON.stringify(updating.actions.map((item) => item.action)), ok: updateOk })
  rec({ step: 'k1-22-entry-update', what: '入口切到 update 档', expected: 'state=update 且文案含「有新版本 0.0.2」', actual: JSON.stringify(entryUpdate), ok: entryUpdate.state === 'update' && entryUpdate.text.indexOf('有新版本') >= 0 })
  rec({ step: 'k1-23-install-button-update', what: '安装按钮切到 update 档并给安装动作', expected: 'kind=update 且 buttons 含 action=install', actual: JSON.stringify({ kind: buttonUpdate.kind, buttons: buttonUpdate.buttons.map((item) => item.action) }), ok: buttonUpdate.kind === 'update' && buttonUpdate.buttons.some((item) => item.action === 'install') })

  const changelogVisible = await elementVisible(ui1, cardA, panelA.replace('"]', '"] .dsh-upd-changelog'))
  if (!changelogVisible) {
    await clickInCard(ui1, cardA, panelA + ' button[data-action="toggle-changelog"]')
    await sleep(500)
  }
  const expanded = await waitForChangelog(ui1, cardA, panelA, FIXTURE_VARIANT_VERSION)
  const changelog = expanded.changelog
  await capture(ctx.run, ui1, {
    step: 'k1-25-changelog',
    what: 'changelog：行内 markdown、裸 URL、BREAKING、yanked、六类与版本节上限截断提示',
    expected: '版本节含 0.0.2（标题带「已撤回」）、yanked 横幅、md-code/strong/em/del/link、breaking 徽标、截断提示「仅显示前 100 条」',
    actual: JSON.stringify({ heading: changelog ? changelog.heading : null, yanked: changelog ? changelog.yanked : null, truncnote: changelog ? changelog.truncnote : null, cats: changelog ? changelog.cats : null, foldCats: changelog ? changelog.foldCats : null }),
    verdict: changelog ? 'pass' : 'fail',
  })
  const versionNode = changelog ? changelog.versions.find((item) => item.version === '0.0.2') || null : null
  rec({ step: 'k1-26-changelog-heading', what: 'changelog 区间标题', expected: '「更新说明（0.0.1 → 0.0.2）：」', actual: changelog ? changelog.heading : '(无 changelog)', ok: !!changelog && changelog.heading === '更新说明（0.0.1 → 0.0.2）：' })
  rec({ step: 'k1-27-yanked', what: 'yanked 版本标记：版本标题后缀 + 文档级横幅', expected: '版本节 0.0.2 标题含「已撤回」、yanked 横幅含「已被作者撤回（yanked）」', actual: JSON.stringify({ versionTitle: versionNode ? versionNode.title : null, yanked: changelog ? changelog.yanked : null }), ok: !!versionNode && versionNode.title.indexOf('已撤回') >= 0 && !!changelog && changelog.yanked.indexOf('已被作者撤回（yanked）') >= 0 })
  rec({ step: 'k1-28-truncnote', what: '版本节上限（100 条）触发的截断提示', expected: '截断提示含「仅显示前 100 条」', actual: changelog ? changelog.truncnote : '(无 changelog)', ok: !!changelog && changelog.truncnote.indexOf('仅显示前 100 条') >= 0 })
  const changelogCats = changelog ? changelog.cats.filter((item) => !!item).length + changelog.foldCats.filter((item) => !!item).length : 0
  rec({ step: 'k1-29-cats', what: '六类小节（含折叠类）都在 DOM', expected: '类别小节数 >= 6', actual: String(changelogCats) + '；cats=' + JSON.stringify(changelog ? changelog.cats : null) + '；fold=' + JSON.stringify(changelog ? changelog.foldCats : null), ok: changelogCats >= 6 })
  rec({ step: 'k1-30-md-code', what: '行内 code 渲染', expected: 'md-code 含「updateCheck」', actual: JSON.stringify(changelog ? changelog.mdCodes : null), ok: !!changelog && changelog.mdCodes.some((item) => item.indexOf('updateCheck') >= 0) })
  rec({ step: 'k1-31-md-strong-em-del', what: '行内 strong/em/del 渲染', expected: 'strong 含「安装按钮」、em 含「更新日志」、del 含「保留」', actual: JSON.stringify({ strong: changelog ? changelog.mdStrongs : null, em: changelog ? changelog.mdEms : null, del: changelog ? changelog.mdDels : null }), ok: !!changelog && changelog.mdStrongs.some((item) => item.indexOf('安装按钮') >= 0) && changelog.mdEms.some((item) => item.indexOf('更新日志') >= 0) && changelog.mdDels.some((item) => item.indexOf('保留') >= 0) })
  rec({ step: 'k1-32-links', what: 'markdown 链接与裸 URL 都可点（http/https）', expected: 'md-link 同时含 example.com/dsh-plugin-update 与 example.com/changelog', actual: JSON.stringify(changelog ? changelog.mdLinks : null), ok: !!changelog && changelog.mdLinks.some((item) => item.href === 'https://example.com/dsh-plugin-update') && changelog.mdLinks.some((item) => item.href === 'https://example.com/changelog') })
  rec({ step: 'k1-33-no-html', what: 'changelog 不直通 HTML（无 script 注入）', expected: 'changelog 内无 script 标签', actual: String(changelog ? changelog.hasScript : null), ok: !!changelog && changelog.hasScript === false })
  rec({ step: 'k1-34-breaking', what: 'BREAKING 徽标', expected: 'breaking 徽标 >= 1', actual: JSON.stringify(changelog ? changelog.breakingBadges : null), ok: !!changelog && changelog.breakingBadges.length >= 1 })

  await clickInCard(ui1, cardA, panelA + ' button[data-action="install"]')
  const busy = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'busy', '安装中横幅', 60000)
  const entryBusy = await readEntry(ui1, cardA)
  const buttonBusy = await readInstallButton(ui1, cardA)
  const busyOk = busy.banner !== null && busy.banner.title === '正在安装 0.0.2…关闭面板不会中断。'
  await capture(ctx.run, ui1, {
    step: 'k1-30-installing',
    what: '安装进行中：忙碌横幅 + 禁用动作 + 入口/安装按钮 busy 档',
    expected: '横幅「正在安装 0.0.2…关闭面板不会中断。」、安装动作禁用、入口「正在安装…」',
    actual: JSON.stringify(busy.banner) + '；actions=' + JSON.stringify(busy.actions.map((item) => ({ action: item.action, disabled: item.disabled }))) + '；入口=' + JSON.stringify({ state: entryBusy.state, text: entryBusy.text }),
    verdict: busyOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-35-busy-banner', what: '安装中横幅原文', expected: '标题精确等于「正在安装 0.0.2…关闭面板不会中断。」', actual: JSON.stringify(busy.banner), ok: busyOk })
  rec({ step: 'k1-36-busy-entry', what: '入口切 busy 档', expected: 'state=busy、文案「正在安装…」', actual: JSON.stringify(entryBusy), ok: entryBusy.state === 'busy' && entryBusy.text === '正在安装…' })
  rec({ step: 'k1-37-busy-install-button', what: '安装按钮切 busy 档', expected: 'kind=busy', actual: String(buttonBusy.kind), ok: buttonBusy.kind === 'busy' })

  await waitDiskVersions(ctx, { [packageA]: FIXTURE_VARIANT_VERSION }, 'K1 A 装到 0.0.2')
  const restartState = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'restart', '待重启横幅')
  const entryRestart = await readEntry(ui1, cardA)
  const restartOk = restartState.banner !== null && restartState.banner.title === '新版本 0.0.2 已安装，重启宿主后生效。'
  await capture(ctx.run, ui1, {
    step: 'k1-40-restart-required',
    what: '安装完成待重启：面板待重启横幅 + 入口待重启',
    expected: '横幅「新版本 0.0.2 已安装，重启宿主后生效。」、入口「待重启」',
    actual: JSON.stringify(restartState.banner) + '；入口=' + JSON.stringify({ state: entryRestart.state, text: entryRestart.text }),
    verdict: restartOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-41-restart-banner', what: '待重启横幅原文', expected: '标题精确等于「新版本 0.0.2 已安装，重启宿主后生效。」', actual: JSON.stringify(restartState.banner), ok: restartOk })
  rec({ step: 'k1-42-restart-entry', what: '入口待重启档', expected: 'state=restart、文案「待重启」', actual: JSON.stringify(entryRestart), ok: entryRestart.state === 'restart' && entryRestart.text === '待重启' })

  await stopHostGen(ctx, gen1, 'k1-before-restart')
  const events1 = await readEvents(ctx)
  const execs1 = installExecsOf(events1, packageA)
  const fails1 = installFailsOf(events1, packageA)
  const verifies1 = eventsNamed(events1, 'update.install.verify')
  const verifyA = verifies1.find((event) => String(event.fields['pluginId'] || '') === packageA || String(event.fields['installedVersion'] || '') === FIXTURE_VARIANT_VERSION)
  const ledgerA1 = await waitForLedger(ctx, packageA, ['restart-required'], 'K1 A 台账待重启', 60000)
  const diskAfterInstall = await diskVersions(ctx, [packageA])
  await ctx.run.raw('k1-gen1-logs', { execs: execs1, fails: fails1, verifies: verifies1, ledger: ledgerA1, disk: diskAfterInstall })
  rec({ step: 'k1-43-exec-once', what: '安装执行日志：成功恰一次、无失败', expected: 'A 的 update.install.exec ok=true 恰 1 条、无 update.install.fail', actual: 'exec=' + String(execs1.length) + ' ok=' + String(okExecCount(execs1)) + ' fails=' + String(fails1.length), ok: execs1.length === 1 && okExecCount(execs1) === 1 && fails1.length === 0 })
  rec({ step: 'k1-44-verify', what: '安装校验结论为待重启', expected: 'update.install.verify.result=restart-required、installedVersion=0.0.2', actual: JSON.stringify(verifyA ? verifyA.fields : null), ok: !!verifyA && verifyA.fields['result'] === 'restart-required' && verifyA.fields['installedVersion'] === '0.0.2' })
  rec({ step: 'k1-45-ledger-restart', what: '台账逐行真相：目标 0.0.2、状态待重启', expected: 'state=restart-required、targetVersion=0.0.2', actual: JSON.stringify(ledgerA1 ? { state: ledgerStateOf(ledgerA1), targetVersion: ledgerA1.state['targetVersion'] } : null), ok: ledgerStateOf(ledgerA1) === 'restart-required' && ledgerA1 !== null && ledgerA1.state['targetVersion'] === '0.0.2' })
  rec({ step: 'k1-46-disk-after-install', what: '磁盘装到 0.0.2', expected: 'A 磁盘版本=0.0.2', actual: JSON.stringify(diskAfterInstall), ok: diskAfterInstall[packageA] === FIXTURE_VARIANT_VERSION })

  const gen2 = await startHostGen(ctx, 'k1-gen2')
  const ui2 = uiOf(gen2)
  await waitForBody(ui2, '夹具 A 本体', 'gen2 A 卡片挂载')
  const done = await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', '重启后已了结', 180000)
  const tagsAfter = await readCardTags(ui2, cardA)
  const entryDone = await readEntry(ui2, cardA)
  const buttonDone = await readInstallButton(ui2, cardA)
  const cAfter = (await readPanel(ui2, cardA, panelC)) as PanelState
  const doneOk = done.banner !== null && done.banner.title === '已是最新，无需更新。'
  const tagsOk = tagsAfter.clientTag === tagsA.clientTag && tagsAfter.hostTag === tagsA.hostTag
  await capture(ctx.run, ui2, {
    step: 'k1-50-after-restart',
    what: '重启后：面板已了结、卡片构建标记 v0.0.2、安装按钮 done、额外面板 C 仍未安装',
    expected: '横幅「已是最新，无需更新。」、clientTag/hostTag 均为 0.0.2、按钮 kind=done、C 横幅「未安装」',
    actual: JSON.stringify(done.banner) + '；tags=' + JSON.stringify(tagsAfter) + '；按钮 kind=' + String(buttonDone.kind) + '；C=' + JSON.stringify(cAfter.banner),
    verdict: doneOk && tagsOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-51-done-banner', what: '重启后面板已了结原文', expected: '标题精确等于「已是最新，无需更新。」', actual: JSON.stringify(done.banner), ok: doneOk })
  rec({ step: 'k1-52-build-tags', what: '重启后运行的是 0.0.2 构建', expected: 'clientTag=' + tagsA.clientTag + '、hostTag=' + tagsA.hostTag, actual: JSON.stringify(tagsAfter), ok: tagsOk })
  rec({ step: 'k1-53-install-button-done', what: '安装按钮回到 done 档', expected: 'kind=done', actual: String(buttonDone.kind), ok: buttonDone.kind === 'done' })
  rec({ step: 'k1-54-entry-done', what: '入口已是最新备注', expected: 'note 含「已是最新 0.0.2」', actual: JSON.stringify(entryDone), ok: entryDone.note.indexOf('已是最新') >= 0 && entryDone.note.indexOf('0.0.2') >= 0 })
  const ledgerA2 = await waitForLedger(ctx, packageA, ['completed'], 'K1 A 台账已完成', 60000)
  rec({ step: 'k1-55-ledger-completed', what: '重启后台账收敛为已完成', expected: 'state=completed', actual: JSON.stringify(ledgerA2 ? { state: ledgerStateOf(ledgerA2), targetVersion: ledgerA2.state['targetVersion'] } : null), ok: ledgerStateOf(ledgerA2) === 'completed' })

  await clickInCard(ui2, cardA, panelC + ' button[data-action="check"]')
  const cFirst = await waitForPanel(ui2, cardA, panelC, (state) => state.banner !== null && state.banner.kind === 'update', 'C 首次安装横幅', 60000)
  const cFirstState = await waitForChangelogOrNeutral(ui2, cardA, panelC, 60000)
  const cFirstOk = cFirst.banner !== null && cFirst.banner.title === '首次安装 0.0.2（新增依赖）。'
  const cChangelogText = cFirstState.changelog ? cFirstState.changelog.neutral + ' ' + cFirstState.changelog.text : ''
  const cChangelogOk = cChangelogText.indexOf('作者未提供更新说明') >= 0 || cChangelogText.indexOf('没有更新说明文件') >= 0
  await capture(ctx.run, ui2, {
    step: 'k1-60-first-install',
    what: '未安装插件的首次安装态 + 无 changelog 的中性提示',
    expected: '横幅「首次安装 0.0.2（新增依赖）。」、changelog 区给出作者未提供/文件缺失的中性提示',
    actual: JSON.stringify(cFirst.banner) + '；changelog=' + JSON.stringify(cFirstState.changelog ? { neutral: cFirstState.changelog.neutral, text: cFirstState.changelog.text.slice(0, 200) } : null),
    verdict: cFirstOk && cChangelogOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-61-first-install-banner', what: '首次安装横幅原文', expected: '标题精确等于「首次安装 0.0.2（新增依赖）。」', actual: JSON.stringify(cFirst.banner), ok: cFirstOk })
  rec({ step: 'k1-62-changelog-neutral', what: '无 changelog 时的中性提示（非取数失败）', expected: 'changelog 区含「作者未提供更新说明」或「没有更新说明文件」', actual: cChangelogText.slice(0, 400), ok: cChangelogOk })
}

/** 等 changelog 区出现任意内容（有版本节或无更新说明的中性态）。 */
async function waitForChangelogOrNeutral(ui: UiHandle, cardSelector: string, pluginSelector: string, timeoutMs = 60000): Promise<PanelState> {
  return waitForPanel(ui, cardSelector, pluginSelector, (state) => !!state.changelog && (state.changelog.versions.length > 0 || state.changelog.neutral.length > 0 || state.changelog.text.length > 0), 'changelog 中性/内容', timeoutMs)
}

/** K2：坏 tarball（元数据/dist.integrity 不动）→ 失败面 + 最后手段 + 手工命令 → 停宿主真执行 → 重启落定。 */
async function runK2(ctx: KContext, options: KUiScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('K2 需要夹具环境（run.fixtureEnv 为空）')
  const packageA = FIXTURE_SLOT_A.packageName
  const cardA = cardSelectorOf('a')
  const panelA = '.dsh-upd[data-plugin="' + packageA + '"]'
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)

  // 只改 tarball 字节：版本元数据与 dist.integrity 不动 ⇒ check 能过、install 必失败。
  const fault = await corruptPublishedTarball({ registry: fixtureEnv.registry, backupDir: join(ctx.run.layout.rawDir, 'k2-corrupt-a'), packageName: packageA, version: FIXTURE_VARIANT_VERSION })
  await ctx.run.raw('k2-corrupt-tarball', fault)
  rec({
    step: 'k2-01-corrupt-tarball',
    what: '只改 registry 上已发布 tarball 的字节（中点起 64 字节 xor），版本元数据与 dist.integrity 一字不动',
    expected: 'versionDocUnchanged=true、sha256Before≠sha256After、改坏前后 tarball URL 都回 200 且字节数不变',
    actual: JSON.stringify({ versionDocUnchanged: fault.versionDocUnchanged, shaChanged: fault.sha256Before !== fault.sha256After, servedBeforeStatus: fault.servedBeforeStatus, servedAfterStatus: fault.servedAfterStatus, servedBeforeBytes: fault.servedBeforeBytes, servedAfterBytes: fault.servedAfterBytes, sizeBytes: fault.sizeBytes }),
    ok: fault.versionDocUnchanged === true && fault.sha256Before !== fault.sha256After && fault.servedBeforeStatus === 200 && fault.servedAfterStatus === 200 && fault.servedBeforeBytes === fault.servedAfterBytes && fault.servedAfterBytes === fault.sizeBytes,
  })

  const gen1 = await startHostGen(ctx, 'k2-gen1')
  const ui1 = uiOf(gen1)
  await waitForBody(ui1, '夹具 A 本体', 'A 卡片挂载')
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null, 'A 面板初始')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  const update = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', '坏 tarball 下检查仍给出可更新')
  const updateOk = update.banner !== null && update.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。'
  await capture(ctx.run, ui1, {
    step: 'k2-10-check-passes',
    what: 'tarball 字节已坏、元数据与完整性摘要未变：检查更新仍给出可更新（可证伪：若 check 读了 tarball 内容，这一格会失败）',
    expected: '可更新横幅原文「有新版本 0.0.2 可安装（当前版本 0.0.1）。」',
    actual: JSON.stringify(update.banner),
    verdict: updateOk ? 'pass' : 'fail',
  })
  rec({ step: 'k2-02-check-passes', what: '坏 tarball 不影响检查阶段（check 只读版本文档）', expected: '可更新横幅原文精确匹配', actual: JSON.stringify(update.banner), ok: updateOk })

  await clickInCard(ui1, cardA, panelA + ' button[data-action="install"]')
  const failed = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'failed', '安装失败横幅', INSTALL_TIMEOUT_MS)
  await sleep(500)
  const failedFull = (await readPanel(ui1, cardA, panelA)) as PanelState
  const entryFailed = await readEntry(ui1, cardA)
  const buttonFailed = await readInstallButton(ui1, cardA)
  const failBanner = failed.banner
  const failTitle = failBanner ? failBanner.title : ''
  const failSub = failBanner ? failBanner.sub : ''
  const lastResort = failedFull.lastResort
  const manual = failedFull.manual
  const manualCode = manual && manual.code ? manual.code : ''
  const failBannerOk = failBanner !== null && failTitle.indexOf('更新失败（install-failed）') === 0 && failedFull.errCode === 'install-failed'
  const lastResortOk = !!lastResort && lastResort.present && lastResort.badge === '最后手段' && lastResort.status === '自动恢复不可用' && lastResort.reason === '没有可用的自动数据路径；复制这条命令是唯一出路。'
  const manualHeadingOk = !!manual && manual.present && manual.heading === '手工备用命令（请复制整行执行）：'
  const manualCommandOk = /^dsh plugin --profile t10ui add --save-exact \S+@0\.0\.2 --registry=http:\/\/127\.0\.0\.1:\d+\/?$/.test(manualCode)
  const entryFailedOk = entryFailed.state === 'failed' && entryFailed.text === '更新失败，请查看详情'
  const buttonFailedOk = buttonFailed.kind === 'failed'
  await capture(ctx.run, ui1, {
    step: 'k2-20-failure-last-resort',
    what: '安装失败：失败横幅 + 最后手段条 + 手工备用命令（当帧可信）+ 入口/安装按钮失败档',
    expected: '横幅标题以「更新失败（install-failed）」开头、最后手段三字段原文、手工命令形状 --profile t10ui add --save-exact <pkg>@0.0.2 --registry=<本 run registry>、入口「更新失败，请查看详情」、按钮 kind=failed',
    actual: JSON.stringify({ banner: failBanner, errCode: failedFull.errCode, lastResort, manual: manual ? { heading: manual.heading, code: manual.code, neutral: manual.neutral } : null, entry: { state: entryFailed.state, text: entryFailed.text }, buttonKind: buttonFailed.kind }),
    verdict: failBannerOk && lastResortOk && manualHeadingOk && manualCommandOk && entryFailedOk && buttonFailedOk ? 'pass' : 'fail',
  })
  rec({ step: 'k2-03-failure-banner', what: '失败横幅标题与错误码一致', expected: '标题以「更新失败（install-failed）」开头、errCode=install-failed', actual: JSON.stringify({ title: failTitle, sub: failSub, errCode: failedFull.errCode }), ok: failBannerOk })
  rec({ step: 'k2-04-last-resort', what: '最后手段条只在「无自动救援 + 命令当帧可信」时出现，原文三字段', expected: 'badge=最后手段、status=自动恢复不可用、reason=「没有可用的自动数据路径；复制这条命令是唯一出路。」', actual: JSON.stringify(lastResort), ok: lastResortOk })
  rec({ step: 'k2-05-manual-command', what: '手工备用命令原文（与命令形状对齐、registry 指向本 run）', expected: '标题「手工备用命令（请复制整行执行）：」+ 命令行匹配 dsh plugin --profile t10ui add --save-exact <pkg>@0.0.2 --registry=http://127.0.0.1:<port>', actual: JSON.stringify({ heading: manual ? manual.heading : null, code: manualCode, neutral: manual ? manual.neutral : null }), ok: manualHeadingOk && manualCommandOk })
  rec({ step: 'k2-06-entry-failed', what: '入口随安装失败落到失败档', expected: 'state=failed、文案「更新失败，请查看详情」', actual: JSON.stringify(entryFailed), ok: entryFailedOk })
  rec({ step: 'k2-07-install-button-failed', what: '安装按钮切失败档', expected: 'kind=failed', actual: String(buttonFailed.kind), ok: buttonFailedOk })

  await stopHostGen(ctx, gen1, 'k2-after-failure')
  const events1 = await readEvents(ctx)
  const execs1 = installExecsOf(events1, packageA)
  const fails1 = installFailsOf(events1, packageA)
  const ledger1 = await waitForLedger(ctx, packageA, ['failed'], 'K2 A 台账失败', 60000)
  const diskAfterFail = await diskVersions(ctx, [packageA])
  await ctx.run.raw('k2-gen1-logs', { execs: execs1, fails: fails1, ledger: ledger1, disk: diskAfterFail })
  const execFailedOk = execs1.length >= 1 && execs1.every((event) => event.fields['ok'] === false) && okExecCount(execs1) === 0
  const failFact = fails1[0] || null
  const failFactOk = fails1.length === 1 && !!failFact && failFact.fields['stage'] === 'exec' && failFact.fields['reason'] === 'nonzero-exit' && failFact.fields['code'] === 'install-failed' && typeof failFact.fields['exitCode'] === 'number' && failFact.fields['exitCode'] !== 0
  rec({ step: 'k2-08-exec-failed', what: '安装执行阶段真的跑了 pnpm 且非零退出（不是 check 阶段失败）', expected: 'update.install.exec 全部 ok=false（至少 1 条）、无成功', actual: 'exec=' + String(execs1.length) + ' ok=' + String(okExecCount(execs1)) + ' exit=' + JSON.stringify(execs1.map((event) => event.fields['exitCode'])), ok: execFailedOk })
  rec({ step: 'k2-09-fail-fact', what: '失败事件的阶段/原因/码/退出码', expected: 'update.install.fail 恰 1 条、stage=exec、reason=nonzero-exit、code=install-failed、exitCode≠0', actual: JSON.stringify(failFact ? failFact.fields : null), ok: failFactOk })
  rec({ step: 'k2-10-disk-unchanged', what: '安装失败后磁盘保持旧版（无半装/假成功）', expected: 'A 磁盘版本仍 0.0.1', actual: JSON.stringify(diskAfterFail), ok: diskAfterFail[packageA] === FIXTURE_BASE_VERSION })
  rec({ step: 'k2-11-ledger-failed', what: '台账逐行真相：失败行目标版本 0.0.2、状态 failed', expected: 'state=failed、targetVersion=0.0.2', actual: JSON.stringify(ledger1 ? { state: ledgerStateOf(ledger1), targetVersion: ledger1.state['targetVersion'] } : null), ok: ledgerStateOf(ledger1) === 'failed' && ledger1 !== null && ledger1.state['targetVersion'] === FIXTURE_VARIANT_VERSION })

  const restore = await restoreCorruptedTarball({ registry: fixtureEnv.registry, fault })
  await ctx.run.raw('k2-restore-tarball', restore)
  rec({ step: 'k2-12-restore', what: '还原 tarball 字节（恢复后回包 sha 与原始一致、元数据未动）', expected: 'shaMatches=true、versionDocUnchanged=true', actual: JSON.stringify(restore), ok: restore.shaMatches === true && restore.versionDocUnchanged === true })

  // 停宿主后照面板给出的命令原样执行（只去掉开头的 dsh 前缀），证明面板原文可用。
  const tokens = manualCode.trim().split(/\s+/)
  const manualShapeOk = tokens.length >= 8 && tokens[0] === 'dsh' && tokens[1] === 'plugin' && tokens.indexOf('--profile') >= 0
  if (!manualShapeOk) throw new Error('手工命令形状不符合预期：' + manualCode)
  const manualResult = runDshCli(tokens.slice(1), { homeDir: ctx.homeDir, timeoutMs: 300000 })
  await ctx.run.raw('k2-manual-command-exec', { command: manualCode, argv: tokens.slice(1), exitCode: manualResult.exitCode, durationMs: manualResult.durationMs, stdoutTail: manualResult.stdout.slice(-6000), stderrTail: manualResult.stderr.slice(-6000) })
  const diskFixed = await diskVersions(ctx, [packageA])
  rec({ step: 'k2-13-manual-exec', what: '停宿主后照面板给出的手工命令原文执行，exit=0 且磁盘装到 0.0.2', expected: 'exitCode=0 且 A 磁盘版本=0.0.2', actual: JSON.stringify({ exitCode: manualResult.exitCode, disk: diskFixed, durationMs: manualResult.durationMs }), ok: manualResult.exitCode === 0 && diskFixed[packageA] === FIXTURE_VARIANT_VERSION })

  const gen2 = await startHostGen(ctx, 'k2-gen2')
  const ui2 = uiOf(gen2)
  await waitForBody(ui2, '夹具 A 本体', 'gen2 A 卡片挂载')
  await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', '手工修复后重启落定', 180000)
  const doneFull = (await readPanel(ui2, cardA, panelA)) as PanelState
  const tagsAfter = await readCardTags(ui2, cardA)
  const settled = doneFull.settled
  const doneOk = doneFull.banner !== null && doneFull.banner.kind === 'done' && doneFull.banner.title === '已是最新，无需更新。'
  const settledOk = settled.indexOf('上次尝试失败（install-failed）') >= 0 && settled.indexOf('0.0.2') >= 0
  const tagsOk = tagsAfter.clientTag === tagsA.clientTag && tagsAfter.hostTag === tagsA.hostTag
  const ledger2 = await ledgerFor(ctx, packageA)
  await capture(ctx.run, ui2, {
    step: 'k2-30-after-manual-fix',
    what: '手工命令修好后重启宿主：面板按磁盘真相了结，旧失败只留中性历史行',
    expected: '横幅「已是最新，无需更新。」、settled 历史行含「上次尝试失败（install-failed）」与 0.0.2、clientTag/hostTag=0.0.2',
    actual: JSON.stringify({ banner: doneFull.banner, settled, tags: tagsAfter }),
    verdict: doneOk && settledOk && tagsOk ? 'pass' : 'fail',
  })
  rec({ step: 'k2-14-settled-banner', what: '重启后面板了结（不把已修好的包继续报成当前失败）', expected: '横幅 kind=done 且标题「已是最新，无需更新。」', actual: JSON.stringify(doneFull.banner), ok: doneOk })
  rec({ step: 'k2-15-settled-history', what: '旧失败以中性历史行保留（失败事实仍可追溯）', expected: 'settled 行含「上次尝试失败（install-failed）」与「0.0.2」', actual: settled, ok: settledOk })
  rec({ step: 'k2-16-build-tags', what: '重启后运行 0.0.2 构建', expected: 'clientTag=' + tagsA.clientTag + '、hostTag=' + tagsA.hostTag, actual: JSON.stringify(tagsAfter), ok: tagsOk })
  rec({ step: 'k2-17-ledger-history', what: '台账保留失败历史（真相优先；不因手工修复而伪造成功）', expected: 'state=failed、targetVersion=0.0.2', actual: JSON.stringify(ledger2 ? { state: ledgerStateOf(ledger2), targetVersion: ledger2.state['targetVersion'] } : null), ok: ledgerStateOf(ledger2) === 'failed' && ledger2 !== null && ledger2.state['targetVersion'] === FIXTURE_VARIANT_VERSION })
}

/** K3：三包批量面板全状态 —— 初始待查询 / 检查后可更新 / 安装中 / 部分失败隔离 / 恢复后行内重试 / 重启后一致。 */
async function runK3(ctx: KContext, options: KUiScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('K3 需要夹具环境')
  const packageA = FIXTURE_SLOT_A.packageName
  const packageB = FIXTURE_SLOT_B.packageName
  const packageC = FIXTURE_SLOT_C.packageName
  const cardA = cardSelectorOf('a')
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)
  const tagsB = fixtureBuildTagsOf(FIXTURE_SLOT_B, FIXTURE_VARIANT_VERSION)
  const tagsC = fixtureBuildTagsOf(FIXTURE_SLOT_C, FIXTURE_VARIANT_VERSION)

  // ---- 0. 起宿主（延迟代理只慢 pnpm 下载，check 不受影响；用来拍「安装中」窗） ----
  const gen1 = await startHostGen(ctx, 'k3-gen1', { delayMs: 3000, match: 'pnpm-user-agent' })
  const ui1 = uiOf(gen1)
  const live = (): DesktopSession => webSessionOf(ui1.page)
  await waitForBody(ui1, '夹具 A 本体', 'A 卡片挂载')
  const initialSeat = await waitForBatchSeat(live(), 'a', (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3, { label: 'A 批量面板三行挂载', timeoutMs: 180000, intervalMs: 500 })
  const initialRows = initialSeat.panel.rows
  const initialPending = initialRows.length === 3 && initialRows.every((row) => row.phase === 'pending' || row.phase === 'never')
  const initialKeys = initialRows.map((row) => row.key).join(',')
  await capture(ctx.run, ui1, {
    step: 'k3-10-initial',
    what: '批量面板初始：三行待查询、总账/台账报待查询、宏按钮可点（未查更新）',
    expected: 'rows=a,b,c；三行 phase=pending；总账含「3 个尚未查询」；台账含「3 个待查询」',
    actual: 'rows=' + initialKeys + '；phases=' + JSON.stringify(initialRows.map((row) => row.phase)) + '；summary=' + JSON.stringify(initialSeat.panel.summary) + '；ledger=' + JSON.stringify(initialSeat.panel.ledger),
    verdict: initialKeys === 'a,b,c' && initialPending ? 'pass' : 'fail',
  })
  rec({ step: 'k3-01-initial-rows', what: '批量面板初始三行且都未查询', expected: '三行 key=a,b,c；phase=pending', actual: 'rows=' + initialKeys + '；phases=' + JSON.stringify(initialRows.map((row) => row.phase)), ok: initialKeys === 'a,b,c' && initialPending })
  rec({ step: 'k3-02-initial-summary', what: '总账与台账在初始态报「待查询」', expected: 'summary 含「3 个尚未查询」；ledger 含「3 个待查询」', actual: 'summary=' + JSON.stringify(initialSeat.panel.summary) + '；ledger=' + JSON.stringify(initialSeat.panel.ledger), ok: initialSeat.panel.summary.indexOf('3 个尚未查询') >= 0 && initialSeat.panel.ledger.indexOf('3 个待查询') >= 0 })

  // ---- 1. 真 UI 点「检查更新」→ 三行可更新 ----
  await waitForBatchSeat(live(), 'a', (state) => state.panel.check !== null && state.panel.check.disabled === false, { label: '批量宏「检查更新」可点', timeoutMs: 120000, intervalMs: 500 })
  await clickSeatAction(live(), 'a', 'check')
  const readySeat = await waitForBatchSeat(live(), 'a', (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => row.versionNew === FIXTURE_VARIANT_VERSION), { label: '批量检查后三行可更新 0.0.2', timeoutMs: 180000, intervalMs: 500 })
  const readyRows = readySeat.panel.rows
  const readyOk = readyRows.length === 3 && readyRows.every((row) => row.versionCur === FIXTURE_BASE_VERSION && row.versionNew === FIXTURE_VARIANT_VERSION)
  const installMacroReady = readySeat.panel.install !== null && readySeat.panel.install.disabled === false
  await capture(ctx.run, ui1, {
    step: 'k3-20-ready',
    what: '检查更新后：三行都列出 0.0.1 → 0.0.2，总账「3 个可更新」，「全部更新」可点',
    expected: '每行 cur=0.0.1、new=0.0.2；summary 含「3 个可更新」；install 宏可点',
    actual: 'rows=' + JSON.stringify(readyRows.map((row) => ({ key: row.key, cur: row.versionCur, next: row.versionNew, phase: row.phase }))) + '；summary=' + JSON.stringify(readySeat.panel.summary) + '；ledger=' + JSON.stringify(readySeat.panel.ledger) + '；installDisabled=' + String(readySeat.panel.install ? readySeat.panel.install.disabled : null),
    verdict: readyOk && installMacroReady ? 'pass' : 'fail',
  })
  rec({ step: 'k3-03-ready-rows', what: '检查更新后三行的当前/新版本', expected: '三行 cur=0.0.1、new=0.0.2', actual: JSON.stringify(readyRows.map((row) => ({ key: row.key, cur: row.versionCur, next: row.versionNew }))), ok: readyOk })
  rec({ step: 'k3-04-ready-summary', what: '就绪态总账/台账与宏按钮', expected: 'summary 含「3 个可更新」；ledger 含「3 个可更新」；install 可点', actual: 'summary=' + JSON.stringify(readySeat.panel.summary) + '；ledger=' + JSON.stringify(readySeat.panel.ledger) + '；installDisabled=' + String(readySeat.panel.install ? readySeat.panel.install.disabled : null), ok: readySeat.panel.summary.indexOf('3 个可更新') >= 0 && readySeat.panel.ledger.indexOf('3 个可更新') >= 0 && installMacroReady })

  // ---- 2. 注入：检查之后、安装之前改坏 B@0.0.2 tarball 字节（元数据/integrity 不动 ⇒ check 过、install 必失败） ----
  const corruption = await corruptPublishedTarball({ registry: fixtureEnv.registry, backupDir: join(ctx.run.layout.rawDir, 'k3-corrupt-b'), packageName: packageB, version: FIXTURE_VARIANT_VERSION })
  await ctx.run.raw('k3-registry-tarball-corrupted', corruption)
  rec({ step: 'k3-05-fault-injection', what: '改坏 B 的 tarball 字节（元数据一字不动）', expected: 'servedBefore/After=200；大小不变；sha256 变了；versionDocUnchanged=true', actual: JSON.stringify({ servedBefore: corruption.servedBeforeStatus, servedAfter: corruption.servedAfterStatus, sizeBytes: corruption.sizeBytes, sha256Before: corruption.sha256Before, sha256After: corruption.sha256After, versionDocUnchanged: corruption.versionDocUnchanged }), ok: corruption.servedBeforeStatus === 200 && corruption.servedAfterStatus === 200 && corruption.sha256Before !== corruption.sha256After && corruption.versionDocUnchanged })

  // ---- 3. 真 UI 点「全部更新」→ 拍安装中窗（只读 DOM 一瞬，之后改轮询磁盘/台账） ----
  await clickSeatAction(live(), 'a', 'install')
  let installingSeat: BatchSeatState | null = null
  try {
    installingSeat = await waitForBatchSeat(live(), 'a', (state) => {
      const running = state.panel.rows.some((row) => row.phase === 'installing' || row.queued === true || (row.status !== null && row.status.indexOf('正在安装') >= 0))
      return running || state.panel.summary.indexOf('安装中') >= 0 || (state.panel.ledger !== null && state.panel.ledger.indexOf('安装中') >= 0)
    }, { label: 'K3 安装中窗（行 installing/queued 或总账含安装中）', timeoutMs: 30000, intervalMs: 200 })
  } catch {
    installingSeat = null
  }
  const installingState = installingSeat !== null ? installingSeat : await readBatchSeat(live(), 'a').catch(() => null)
  const installingOk = installingState !== null && (installingState.panel.rows.some((row) => row.phase === 'installing' || row.queued === true) || installingState.panel.summary.indexOf('安装中') >= 0 || (installingState.panel.ledger !== null && installingState.panel.ledger.indexOf('安装中') >= 0))
  await capture(ctx.run, ui1, {
    step: 'k3-30-installing',
    what: '宏「全部更新」后：批量面板进入安装中（行 installing/queued，总账报安装中）',
    expected: '存在 installing/queued 行或总账含「安装中」；安装宏禁用',
    actual: installingState === null ? '(面板读数不可用)' : 'rows=' + JSON.stringify(installingState.panel.rows.map((row) => ({ key: row.key, phase: row.phase, queued: row.queued, status: row.status }))) + '；summary=' + JSON.stringify(installingState.panel.summary) + '；ledger=' + JSON.stringify(installingState.panel.ledger),
    verdict: installingOk ? 'pass' : 'unknown',
  })
  rec({ step: 'k3-06-installing', what: '安装窗：批量面板如实显示安装中', expected: '存在 installing/queued 行或 summary/ledger 含「安装中」', actual: installingState === null ? 'null' : JSON.stringify({ rows: installingState.panel.rows.map((row) => ({ key: row.key, phase: row.phase, queued: row.queued })), summary: installingState.panel.summary, ledger: installingState.panel.ledger }), ok: installingOk })

  // ---- 4. 安装窗：只轮询磁盘 + 台账（B 坏 tarball 必失败、A/C 照常完成） ----
  const partialDeadline = Date.now() + INSTALL_TIMEOUT_MS
  const observed: string[] = []
  let lastDisk: Record<string, string | null> = {}
  let lastLedgerB: LedgerEntry | null = null
  let partialSettled = false
  while (Date.now() < partialDeadline) {
    lastDisk = await diskVersions(ctx, [packageA, packageB, packageC])
    lastLedgerB = await ledgerFor(ctx, packageB)
    const aOk = lastDisk[packageA] === FIXTURE_VARIANT_VERSION
    const cOk = lastDisk[packageC] === FIXTURE_VARIANT_VERSION
    const bFailed = ledgerStateOf(lastLedgerB) === 'failed'
    const snapshot = 'a=' + String(lastDisk[packageA]) + ',b=' + String(lastDisk[packageB]) + ',c=' + String(lastDisk[packageC]) + ',bLedger=' + ledgerStateOf(lastLedgerB)
    if (observed.length === 0 || observed[observed.length - 1] !== snapshot) observed.push(snapshot)
    if (aOk && cOk && bFailed) {
      partialSettled = true
      break
    }
    await sleep(1000)
  }
  await ctx.run.raw('k3-partial-settled', { partialSettled, disk: lastDisk, ledgerB: { state: ledgerStateOf(lastLedgerB), target: lastLedgerB ? lastLedgerB.state['targetVersion'] : null }, observed: observed.slice(-10) })
  // 等 UI 把失败横幅/行态渲染出来（安装窗结束后面板会重排一次）。
  await sleep(3000)
  const failureSeat = await readBatchSeat(live(), 'a').catch(() => null)
  const failureExtras = await readBatchExtras(ui1, cardA).catch(() => null)
  const failureDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const rowA = failureSeat !== null ? rowOfSeat(failureSeat, 'a') : null
  const rowB = failureSeat !== null ? rowOfSeat(failureSeat, 'b') : null
  const rowC = failureSeat !== null ? rowOfSeat(failureSeat, 'c') : null
  const failureBanner = failureExtras !== null ? failureExtras.failed : null
  const restartBanner = failureExtras !== null ? failureExtras.restart : null
  const bTitle = rowB !== null && rowB.title !== null ? rowB.title : 'B'
  const listHitB = failureBanner !== null && failureBanner.list.some((item) => item.indexOf(bTitle) >= 0 || item.indexOf('夹具 B') >= 0)
  const failedEmpty = failureBanner === null
  const noFalseSuccess = failureSeat !== null && failureSeat.panel.summary.indexOf('3 个已是最新') < 0 && failureSeat.panel.ledger.indexOf('3 个已是最新') < 0
  await capture(ctx.run, ui1, {
    step: 'k3-40-partial-failure',
    what: '部分失败隔离：1 个失败横幅 + B 行失败可重试，A/C 照常完成；总账/台账不谎称全批成功',
    expected: '横幅「1 个插件安装失败。」、名单含 B；B 行 failed 且 fail 含 install-failed、有「重试」行内按钮；summary 含「1 个插件安装失败」；ledger 含「1 个失败」与「2 个待重启」；磁盘 a/c=0.0.2、b=0.0.1；无「3 个已是最新」',
    actual: failureSeat === null ? '(批量面板读数不可用)' : 'failedBanner=' + JSON.stringify(failureBanner) + '；restartBanner=' + JSON.stringify(restartBanner ? { title: restartBanner.title, sub: restartBanner.sub } : null) + '；rowB=' + JSON.stringify(rowB) + '；rowsAC=' + JSON.stringify([rowA !== null ? { key: rowA.key, phase: rowA.phase, status: rowA.status } : null, rowC !== null ? { key: rowC.key, phase: rowC.phase, status: rowC.status } : null]) + '；summary=' + JSON.stringify(failureSeat.panel.summary) + '；ledger=' + JSON.stringify(failureSeat.panel.ledger) + '；disk=' + JSON.stringify(failureDisk),
    verdict: partialSettled && failureBanner !== null && listHitB && rowB !== null && rowB.phase === 'failed' && rowB.actions.indexOf('row-install') >= 0 && failureSeat !== null && failureSeat.panel.summary.indexOf('1 个插件安装失败') >= 0 && failureSeat.panel.ledger.indexOf('1 个失败') >= 0 && failureDisk[packageA] === FIXTURE_VARIANT_VERSION && failureDisk[packageC] === FIXTURE_VARIANT_VERSION && failureDisk[packageB] !== FIXTURE_VARIANT_VERSION ? 'pass' : 'fail',
  })
  rec({ step: 'k3-07-partial-settled', what: '坏行失败落定、好行完成（磁盘 + 台账）', expected: 'a/c 磁盘=0.0.2；b 磁盘≠0.0.2；B 台账 state=failed', actual: JSON.stringify({ settled: partialSettled, disk: failureDisk, bLedger: ledgerStateOf(await ledgerFor(ctx, packageB)), observed: observed.slice(-8) }), ok: partialSettled && failureDisk[packageA] === FIXTURE_VARIANT_VERSION && failureDisk[packageC] === FIXTURE_VARIANT_VERSION && failureDisk[packageB] !== FIXTURE_VARIANT_VERSION })
  rec({ step: 'k3-08-failed-banner', what: '失败横幅：标题/名单/动作提示', expected: '标题等于「1 个插件安装失败。」；名单含 B 标题；sub 等于「请逐家使用行内「重试」；若持续，请提交诊断信息至插件作者。」', actual: JSON.stringify(failureBanner), ok: failureBanner !== null && failureBanner.title === '1 个插件安装失败。' && listHitB && failureBanner.sub === '请逐家使用行内「重试」；若持续，请提交诊断信息至插件作者。' })
  rec({ step: 'k3-09-failed-row', what: 'B 行失败态 truthful（不谎称安装中/成功）', expected: 'phase=failed；status=「安装失败，请选择「重试」。」；fail 含 install-failed；actions 含 row-install', actual: JSON.stringify(rowB), ok: rowB !== null && rowB.phase === 'failed' && rowB.status === '安装失败，请选择「重试」。' && rowB.fail !== null && rowB.fail.indexOf('install-failed') >= 0 && rowB.actions.indexOf('row-install') >= 0 })
  rec({ step: 'k3-10-summary-ledger-partial', what: '总账/台账逐行计数与横幅一致', expected: 'summary 含「1 个插件安装失败；请按下方失败提示逐项重试。」；ledger 含「1 个失败」与「2 个待重启」', actual: JSON.stringify({ summary: failureSeat !== null ? failureSeat.panel.summary : null, ledger: failureSeat !== null ? failureSeat.panel.ledger : null }), ok: failureSeat !== null && failureSeat.panel.summary.indexOf('1 个插件安装失败；请按下方失败提示逐项重试。') >= 0 && failureSeat.panel.ledger.indexOf('1 个失败') >= 0 && failureSeat.panel.ledger.indexOf('2 个待重启') >= 0 })
  rec({ step: 'k3-11-no-false-success', what: '部分失败时无全批假成功（总账/台账/重启横幅都不宣称 3 个已是最新）', expected: '无「3 个已是最新」；磁盘 b≠0.0.2；B 台账 failed', actual: JSON.stringify({ noFalseSuccess, summary: failureSeat !== null ? failureSeat.panel.summary : null, ledger: failureSeat !== null ? failureSeat.panel.ledger : null, disk: failureDisk }), ok: noFalseSuccess && failureDisk[packageB] !== FIXTURE_VARIANT_VERSION && ledgerStateOf(await ledgerFor(ctx, packageB)) === 'failed' })
  rec({ step: 'k3-12-good-rows-unaffected', what: '好行不受坏行影响（A/C 都已装到目标版）', expected: 'a 磁盘=0.0.2、c 磁盘=0.0.2；A/C 台账成功终态', actual: JSON.stringify({ diskA: failureDisk[packageA], diskC: failureDisk[packageC], ledgerA: ledgerStateOf(await ledgerFor(ctx, packageA)), ledgerC: ledgerStateOf(await ledgerFor(ctx, packageC)) }), ok: failureDisk[packageA] === FIXTURE_VARIANT_VERSION && failureDisk[packageC] === FIXTURE_VARIANT_VERSION && SUCCESS_STATES.indexOf(ledgerStateOf(await ledgerFor(ctx, packageA)) as typeof SUCCESS_STATES[number]) >= 0 && SUCCESS_STATES.indexOf(ledgerStateOf(await ledgerFor(ctx, packageC)) as typeof SUCCESS_STATES[number]) >= 0 })
  if (failedEmpty) ctx.run.addNote('K3：部分失败后没有读到失败横幅（安装窗后 UI 可能尚未重排），证据见 k3-40-partial-failure 的 actual')

  // ---- 5. 静置 + 读日志：B 只失败过一次（没有自动重试），A/C 各成功一次 ----
  await sleep(3000)
  const beforeRetryEvents = await readEvents(ctx)
  const beforeExecsA = installExecsOf(beforeRetryEvents, packageA)
  const beforeExecsB = installExecsOf(beforeRetryEvents, packageB)
  const beforeExecsC = installExecsOf(beforeRetryEvents, packageC)
  const beforeFailsB = installFailsOf(beforeRetryEvents, packageB)
  await ctx.run.raw('k3-log-counts-before-retry', { execsA: beforeExecsA, execsB: beforeExecsB, execsC: beforeExecsC, failsB: beforeFailsB })
  rec({ step: 'k3-13-no-auto-retry', what: '失败后静置：B 只执行过一次（失败一次、无自动重试），A/C 各一次成功', expected: 'A/C exec 各 1 且 ok=1；B exec=1 且 ok=0；B install.fail=1', actual: 'execA=' + String(beforeExecsA.length) + ' okA=' + String(okExecCount(beforeExecsA)) + ' execB=' + String(beforeExecsB.length) + ' okB=' + String(okExecCount(beforeExecsB)) + ' execC=' + String(beforeExecsC.length) + ' okC=' + String(okExecCount(beforeExecsC)) + ' failsB=' + String(beforeFailsB.length), ok: beforeExecsA.length === 1 && okExecCount(beforeExecsA) === 1 && beforeExecsB.length === 1 && okExecCount(beforeExecsB) === 0 && beforeExecsC.length === 1 && okExecCount(beforeExecsC) === 1 && beforeFailsB.length === 1 })

  // ---- 6. 恢复 tarball → 真 UI 行内「重试」B → 三行都成功 ----
  const restored = await restoreCorruptedTarball({ registry: fixtureEnv.registry, fault: corruption })
  await ctx.run.raw('k3-registry-tarball-restored', restored)
  rec({ step: 'k3-14-tarball-restored', what: '恢复 B 的 tarball（sha 复原、元数据不变）', expected: 'restoredStatus=200；shaMatches=true；versionDocUnchanged=true', actual: JSON.stringify(restored), ok: restored.restoredStatus === 200 && restored.shaMatches && restored.versionDocUnchanged })
  await waitForBatchSeat(live(), 'a', (state) => {
    const row = rowOfSeat(state, 'b')
    return row !== null && row.actions.indexOf('row-install') >= 0 && row.phase !== 'installing' && row.queued === false
  }, { label: 'B 行出现可用「重试」按钮', timeoutMs: 120000, intervalMs: 500 })
  await clickSeatAction(live(), 'a', 'row-install', 'b')
  const retryDeadline = Date.now() + INSTALL_TIMEOUT_MS
  let retried = false
  let retryDisk: Record<string, string | null> = {}
  while (Date.now() < retryDeadline) {
    retryDisk = await diskVersions(ctx, [packageB])
    if (retryDisk[packageB] === FIXTURE_VARIANT_VERSION) {
      retried = true
      break
    }
    await sleep(800)
  }
  const retriedSeat = await waitForBatchSeat(live(), 'a', (state) => {
    const row = rowOfSeat(state, 'b')
    return row !== null && (row.phase === 'done' || row.phase === 'current') && row.versionCur === FIXTURE_VARIANT_VERSION
  }, { label: 'B 重试成功后行态 done/current 0.0.2', timeoutMs: 180000, intervalMs: 500 })
  await sleep(2000)
  const finalSeat = await readBatchSeat(live(), 'a')
  const finalExtras = await readBatchExtras(ui1, cardA)
  const retryRowB = rowOfSeat(finalSeat, 'b')
  const retryFailedBannerGone = finalExtras.failed === null
  const retrySummary = finalSeat.panel.summary
  const retryLedger = finalSeat.panel.ledger
  const allRowsDone = finalSeat.panel.rows.length === 3 && finalSeat.panel.rows.every((row) => (row.phase === 'done' || row.phase === 'current') && row.versionCur === FIXTURE_VARIANT_VERSION)
  const retryDiskAll = await diskVersions(ctx, [packageA, packageB, packageC])
  await capture(ctx.run, ui1, {
    step: 'k3-50-retried',
    what: '恢复后行内重试成功：B 行转 done/current，失败横幅消失，三行都 0.0.2',
    expected: '三行 0.0.2 且 done/current；失败横幅消失；summary 含「3 个已安装完成」；ledger 含「3 个待重启」；磁盘三包 0.0.2',
    actual: JSON.stringify({ rows: finalSeat.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })), failedBanner: finalExtras.failed, summary: retrySummary, ledger: retryLedger, disk: retryDiskAll }),
    verdict: retried && allRowsDone && retryFailedBannerGone && retryDiskAll[packageA] === FIXTURE_VARIANT_VERSION && retryDiskAll[packageC] === FIXTURE_VARIANT_VERSION ? 'pass' : 'fail',
  })
  rec({ step: 'k3-15-retry-row', what: '重试后 B 行态 truthful', expected: 'phase done/current；versionCur=0.0.2', actual: JSON.stringify({ retried, rowB: retryRowB, rows: finalSeat.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })) }), ok: retried && retryRowB !== null && (retryRowB.phase === 'done' || retryRowB.phase === 'current') && retryRowB.versionCur === FIXTURE_VARIANT_VERSION })
  rec({ step: 'k3-16-retry-banner-gone', what: '重试成功后失败横幅消失、总账转「已安装完成」', expected: 'failed=null；summary 含「3 个已安装完成」；ledger 含「3 个待重启」', actual: JSON.stringify({ failed: finalExtras.failed, summary: retrySummary, ledger: retryLedger }), ok: retryFailedBannerGone && retrySummary.indexOf('3 个已安装完成') >= 0 && retryLedger.indexOf('3 个待重启') >= 0 })
  rec({ step: 'k3-17-retry-disk', what: '重试后三包磁盘都是 0.0.2', expected: '三包 versions=0.0.2', actual: JSON.stringify(retryDiskAll), ok: retryDiskAll[packageA] === FIXTURE_VARIANT_VERSION && retryDiskAll[packageB] === FIXTURE_VARIANT_VERSION && retryDiskAll[packageC] === FIXTURE_VARIANT_VERSION })

  // ---- 7. 停宿主读日志：A/C 不重复安装、B 恰一次失败 + 恰一次成功，台账三行 ----
  const ledgerA = await waitForLedger(ctx, packageA, SUCCESS_STATES as readonly string[], 'K3 A 台账成功终态', 90000)
  const ledgerB = await waitForLedger(ctx, packageB, SUCCESS_STATES as readonly string[], 'K3 B 台账成功终态', 90000)
  const ledgerC = await waitForLedger(ctx, packageC, SUCCESS_STATES as readonly string[], 'K3 C 台账成功终态', 90000)
  await ctx.run.raw('k3-ledger-terminal', { ledgerA, ledgerB, ledgerC })
  rec({ step: 'k3-18-ledger-three', what: '台账逐行真相：三包各恰一条成功终态（无重复/丢行）', expected: '每包 1 条；state∈{completed,restart-required}；targetVersion=0.0.2', actual: JSON.stringify({ a: ledgerA ? { state: ledgerStateOf(ledgerA), target: ledgerA.state['targetVersion'] } : null, b: ledgerB ? { state: ledgerStateOf(ledgerB), target: ledgerB.state['targetVersion'] } : null, c: ledgerC ? { state: ledgerStateOf(ledgerC), target: ledgerC.state['targetVersion'] } : null }), ok: ledgerA !== null && ledgerB !== null && ledgerC !== null && SUCCESS_STATES.indexOf(ledgerStateOf(ledgerA) as typeof SUCCESS_STATES[number]) >= 0 && SUCCESS_STATES.indexOf(ledgerStateOf(ledgerB) as typeof SUCCESS_STATES[number]) >= 0 && SUCCESS_STATES.indexOf(ledgerStateOf(ledgerC) as typeof SUCCESS_STATES[number]) >= 0 && ledgerA.state['targetVersion'] === FIXTURE_VARIANT_VERSION && ledgerB.state['targetVersion'] === FIXTURE_VARIANT_VERSION && ledgerC.state['targetVersion'] === FIXTURE_VARIANT_VERSION })
  await sleep(1500)
  await stopHostGen(ctx, gen1, 'k3-after-retry')
  const afterRetryEvents = await readEvents(ctx)
  const afterExecsA = installExecsOf(afterRetryEvents, packageA)
  const afterExecsB = installExecsOf(afterRetryEvents, packageB)
  const afterExecsC = installExecsOf(afterRetryEvents, packageC)
  const afterFailsB = installFailsOf(afterRetryEvents, packageB)
  const afterStageExecFails = afterFailsB.filter((event) => event.fields['stage'] === 'exec')
  const retryAudit = auditInstallFails(asAuditFacts(afterRetryEvents))
  await ctx.run.raw('k3-log-counts-after-retry', { execsA: afterExecsA, execsB: afterExecsB, execsC: afterExecsC, failsB: afterFailsB, retryAudit })
  rec({ step: 'k3-19-exactly-once', what: '续跑/重试语义：A/C 不重复安装、B 恰一次失败 + 恰一次成功', expected: 'A/C exec=1 且 ok=1；B exec=2（1 失败 1 成功）；stage=exec 的 install.fail 恰 1 且 code=install-failed', actual: 'execA=' + String(afterExecsA.length) + ' okA=' + String(okExecCount(afterExecsA)) + ' execB=' + String(afterExecsB.length) + ' okB=' + String(okExecCount(afterExecsB)) + ' execC=' + String(afterExecsC.length) + ' okC=' + String(okExecCount(afterExecsC)) + ' failsB=' + String(afterFailsB.length) + ' stageExecFails=' + JSON.stringify(afterStageExecFails.map((event) => ({ reason: event.fields['reason'], code: event.fields['code'], exitCode: event.fields['exitCode'] }))), ok: afterExecsA.length === 1 && okExecCount(afterExecsA) === 1 && afterExecsC.length === 1 && okExecCount(afterExecsC) === 1 && afterExecsB.length === 2 && okExecCount(afterExecsB) === 1 && afterFailsB.length === 1 && afterStageExecFails.length === 1 && afterStageExecFails[0] !== undefined && afterStageExecFails[0].fields['code'] === 'install-failed' })
  rec({ step: 'k3-20-fail-audit', what: '失败审计：唯一真失败是坏 tarball 的执行失败（无其它未归因失败）', expected: 'nonCheckExpired=1；命名空间=[B 的命名空间]', actual: JSON.stringify(retryAudit), ok: retryAudit.nonCheckExpired === 1 })

  // ---- 8. 重启宿主：三行 current 0.0.2、总账/台账/卡片标记一致 ----
  const gen2 = await startHostGen(ctx, 'k3-gen2')
  const ui2 = uiOf(gen2)
  await waitForBody(ui2, '夹具 A 本体', 'gen2 A 卡片挂载')
  const restartSeat = await waitForBatchSeat(webSessionOf(ui2.page), 'a', (state) => {
    if (state.card.present !== true || state.panel.present !== true) return false
    if (state.panel.rows.length < 3) return false
    return state.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === FIXTURE_VARIANT_VERSION)
  }, { label: '重启后批量面板三行 current 0.0.2', timeoutMs: 180000, intervalMs: 500 })
  await sleep(1500)
  const finalPanel = await readBatchSeat(webSessionOf(ui2.page), 'a')
  const tagsAfterA = await readCardTags(ui2, cardA)
  const tagsAfterB = await readCardTags(ui2, cardSelectorOf('b')).catch(() => null)
  const tagsAfterC = await readCardTags(ui2, cardSelectorOf('c')).catch(() => null)
  const afterRestartDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const ledgerAfterRestart = {
    a: await waitForLedger(ctx, packageA, SUCCESS_STATES as readonly string[], 'K3 重启后 A 台账终态', 90000),
    b: await waitForLedger(ctx, packageB, SUCCESS_STATES as readonly string[], 'K3 重启后 B 台账终态', 90000),
    c: await waitForLedger(ctx, packageC, SUCCESS_STATES as readonly string[], 'K3 重启后 C 台账终态', 90000),
  }
  const restartRowsOk = restartSeat.panel.rows.length === 3 && restartSeat.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === FIXTURE_VARIANT_VERSION)
  const tagsOk = tagsAfterA.clientTag === tagsA.clientTag && tagsAfterA.hostTag === tagsA.hostTag && tagsAfterB !== null && tagsAfterB.clientTag === tagsB.clientTag && tagsAfterB.hostTag === tagsB.hostTag && tagsAfterC !== null && tagsAfterC.clientTag === tagsC.clientTag
  await capture(ctx.run, ui2, {
    step: 'k3-60-after-restart',
    what: '重启后：批量面板三行 current 0.0.2、总账「已全部为最新」、卡片构建标记 v0.0.2、台账三条成功',
    expected: '三行 current 0.0.2；summary 含「已全部为最新」；ledger 含「3 个已是最新」；A/B clientTag/hostTag=v0.0.2、C clientTag=v0.0.2；台账三包成功',
    actual: JSON.stringify({ rows: finalPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })), summary: finalPanel.panel.summary, ledger: finalPanel.panel.ledger, tagsA: tagsAfterA, tagsB: tagsAfterB, tagsC: tagsAfterC, disk: afterRestartDisk, ledgerStates: { a: ledgerStateOf(ledgerAfterRestart.a), b: ledgerStateOf(ledgerAfterRestart.b), c: ledgerStateOf(ledgerAfterRestart.c) } }),
    verdict: restartRowsOk && tagsOk && afterRestartDisk[packageA] === FIXTURE_VARIANT_VERSION && afterRestartDisk[packageB] === FIXTURE_VARIANT_VERSION && afterRestartDisk[packageC] === FIXTURE_VARIANT_VERSION ? 'pass' : 'fail',
  })
  rec({ step: 'k3-21-restart-rows', what: '重启后批量行相位与版本（UI 与磁盘一致）', expected: '三行 current/done、versionCur=0.0.2', actual: JSON.stringify(finalPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur }))), ok: restartRowsOk && finalPanel.panel.rows.every((row) => row.versionCur === FIXTURE_VARIANT_VERSION) })
  rec({ step: 'k3-22-restart-summary', what: '重启后总账/台账', expected: 'summary 含「已全部为最新」；ledger 含「3 个已是最新」', actual: JSON.stringify({ summary: finalPanel.panel.summary, ledger: finalPanel.panel.ledger }), ok: finalPanel.panel.summary.indexOf('已全部为最新') >= 0 && finalPanel.panel.ledger.indexOf('3 个已是最新') >= 0 })
  rec({ step: 'k3-23-build-tags', what: '三包运行内容都是 0.0.2 构建（不是版本号假成功）', expected: 'A/B clientTag/hostTag 与 C clientTag 都等于 0.0.2 变体标记', actual: JSON.stringify({ tagsA: tagsAfterA, tagsB: tagsAfterB, tagsC: tagsAfterC, expected: { a: tagsA, b: tagsB, c: tagsC } }), ok: tagsOk })
  rec({ step: 'k3-24-restart-ledger', what: '重启后台账三包各一条成功终态（不重复/不丢）', expected: '三包 state∈{completed,restart-required}、targetVersion=0.0.2', actual: JSON.stringify({ a: ledgerStateOf(ledgerAfterRestart.a), b: ledgerStateOf(ledgerAfterRestart.b), c: ledgerStateOf(ledgerAfterRestart.c) }), ok: SUCCESS_STATES.indexOf(ledgerStateOf(ledgerAfterRestart.a) as typeof SUCCESS_STATES[number]) >= 0 && SUCCESS_STATES.indexOf(ledgerStateOf(ledgerAfterRestart.b) as typeof SUCCESS_STATES[number]) >= 0 && SUCCESS_STATES.indexOf(ledgerStateOf(ledgerAfterRestart.c) as typeof SUCCESS_STATES[number]) >= 0 })
  rec({ step: 'k3-25-final-disk', what: '重启后磁盘三包仍 0.0.2（UI/台账/磁盘三处一致）', expected: '三包 versions=0.0.2', actual: JSON.stringify(afterRestartDisk), ok: afterRestartDisk[packageA] === FIXTURE_VARIANT_VERSION && afterRestartDisk[packageB] === FIXTURE_VARIANT_VERSION && afterRestartDisk[packageC] === FIXTURE_VARIANT_VERSION })
}

async function runK4(ctx: KContext, options: KUiScenarioOptions): Promise<void> {
  void ctx
  void options
  throw new Error('k4 待实现')
}

async function runCanRed(ctx: KContext, options: KUiScenarioOptions): Promise<void> {
  void ctx
  void options
  throw new Error('can-red 待实现')
}

/** 组 K 入口：开 run → 准备隔离环境 → 按 mode 跑 → 收尾并落 run.json；定稿 run 复制进仓库。 */
export async function runKUiScenario(options: KUiScenarioOptions): Promise<RunManifest> {
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
    ticket: '274',
  })
  let ctx: KContext | null = null
  try {
    ctx = await prepareRun(run, options)
    if (options.mode === 'k1') await runK1(ctx, options)
    else if (options.mode === 'k2') await runK2(ctx, options)
    else if (options.mode === 'k3') await runK3(ctx, options)
    else if (options.mode === 'k4') await runK4(ctx, options)
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
