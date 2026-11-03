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
 *   - 每 run 私有 pnpm 元数据缓存（pnpm_config_cache_dir）与 npm 缓存（npm_config_cache）：端口复用时不会命中旧 run 的 packument；
 *   - 读日志一律在停宿主之后（dsh-log 有 1000ms 防抖，进程被杀会丢尾行）；
 *   - 试错 run 传 --no-evidence-sync，证据只进 runtime 目录；定稿 run 才复制进仓库。
 *
 * 证据只来自真机观测（DOM / 磁盘 / 台账 state.json / 递归日志 / registry 回包），不编造。
 */
import { spawn } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type { TlsRegistryFront } from '../../fixtures/release/tls-registry-front.ts'
import { startTlsRegistryFront } from '../../fixtures/release/tls-registry-front.ts'
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
import { DSH_PATHS, dshCliEnv } from '../host/dsh-cli.ts'
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
  ariaLabel: string
  title: string
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
  more: { resume: string; resumeTitle: string; cancel: string; cancelConfirm: string; cancelDisabled: boolean; resumeDisabled: boolean } | null
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
  readonly delayMs: number | null
  readonly requestsFrom: number
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
  readonly front: TlsRegistryFront
  readonly gens: HostGen[]
  host: CliHostSession | null
  ui: UiHandle | null
}

/** 台账条目（state.json）。 */
interface LedgerEntry {
  file: string
  state: Record<string, unknown>
  /** state.json 的修改时间（每插件/profile 只有一份，mtime 用来说明读取时刻）。 */
  mtimeMs: number
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
    'var cl=q(".dsh-upd-changelog");' +
    'var wrap=q(".dsh-upd-changelog-wrap");' +
    'var changelog=(cl||wrap)?{present:!!cl,heading:wrap?txt(wrap.querySelector("div")):"",versions:qa(".dsh-upd-changelog-version").map(function(el){return {version:el.getAttribute("data-version"),title:txt(el)}}),yanked:txt(q(".dsh-upd-changelog-yanked")),truncnote:txt(q(".dsh-upd-changelog-truncnote")),cats:qa(".dsh-upd-changelog-cat").map(function(el){return el.getAttribute("data-cat")}),foldCats:qa(".dsh-upd-changelog-fold").map(function(el){return el.getAttribute("data-cat")}),neutral:txt(q(".dsh-upd-changelog-neutral")),mdCodes:qa(".dsh-upd-md-code").map(txt),mdStrongs:cl?Array.prototype.slice.call(cl.querySelectorAll("strong")).map(txt):[],mdEms:cl?Array.prototype.slice.call(cl.querySelectorAll("em")).map(txt):[],mdDels:qa(".dsh-upd-md-del").map(txt),mdLinks:qa(".dsh-upd-md-link").map(function(el){return {text:txt(el),href:el.getAttribute("href")||""}}),breakingBadges:qa(".dsh-upd-breaking-badge").map(txt),hasScript:cl?/<script/i.test(cl.innerHTML):false,text:txt(cl)}:null;' +
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
    'var b=e.querySelector("button");' +
    'return {present:true,variant:e.getAttribute("data-variant"),state:e.getAttribute("data-state"),text:txt(b),note:txt(e.querySelector(".dsh-upd-entry-note")),ariaLabel:b?(b.getAttribute("aria-label")||""):"",title:b?(b.getAttribute("title")||""):""};' +
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
    'var resumeBtn=more?more.querySelector("[data-act=resume]"):null;' +
    'var cancel=more?more.querySelector("[data-act=cancel]"):null;' +
    'return {present:true,failed:fb?{title:txt(fb.querySelector("strong")),sub:txt(fb.querySelector(".dsh-upd-banner-sub")),list:qa(fb,".dsh-upd-blist > *").map(txt),rowline:qa(fb,".dsh-upd-browline button").map(txt)}:null,restart:rb?{title:txt(rb.querySelector("strong")),sub:txt(rb.querySelector(".dsh-upd-banner-sub")),buttons:qa(rb,"button").map(txt)}:null,more:more?{resume:txt(resumeBtn),resumeTitle:resumeBtn?(resumeBtn.getAttribute("title")||""):"",cancel:txt(cancel),cancelConfirm:cancel?(cancel.getAttribute("data-confirm")||""):"",cancelDisabled:cancel?!!cancel.disabled:false,resumeDisabled:resumeBtn?!!resumeBtn.disabled:false}:null,notice:txt(panel.querySelector(".dsh-upd-batch-notice")),summary:txt(panel.querySelector(".dsh-upd-batch-sum")),ledger:txt(panel.querySelector(".dsh-upd-batch-ledger"))};' +
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

/** 轮询入口件直到 predicate 成立（入口轮询周期 5s，断言前必须等目标档）。 */
async function waitForEntry(ui: UiHandle, cardSelector: string, predicate: (state: EntryState) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<EntryState> {
  const deadline = Date.now() + timeoutMs
  let last: EntryState | null = null
  while (Date.now() < deadline) {
    last = await readEntry(ui, cardSelector)
    if (last.present && predicate(last)) return last
    await sleep(POLL_MS)
  }
  throw new Error('等待入口件状态超时（' + label + '）：last=' + JSON.stringify(last))
}

/** 轮询安装按钮直到 predicate 成立（安装按钮轮询周期 5s，断言前必须等目标档）。 */
async function waitForInstallButton(ui: UiHandle, cardSelector: string, predicate: (state: InstallButtonState) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<InstallButtonState> {
  const deadline = Date.now() + timeoutMs
  let last: InstallButtonState | null = null
  while (Date.now() < deadline) {
    last = await readInstallButton(ui, cardSelector)
    if (last.present && predicate(last)) return last
    await sleep(POLL_MS)
  }
  throw new Error('等待安装按钮状态超时（' + label + '）：last=' + JSON.stringify(last))
}

/** 调夹具暴露的 refresh 钩子（产品 controller 的公开 refresh：入口件/安装按钮只在挂载、打开关闭或任务期刷新）。 */
async function refreshFixture(ui: UiHandle, which: 'entry' | 'button'): Promise<void> {
  await ui.page.evaluate<unknown>('(function(){var r=globalThis.__fixtureRefresh;if(!r||typeof r["' + which + '"]!=="function")return null;try{return r["' + which + '"]()}catch(e){return null}})()')
}

/** 刷新入口件后轮询目标档（等待中每轮都 refresh）。 */
async function waitForEntryAfterRefresh(ui: UiHandle, cardSelector: string, predicate: (state: EntryState) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<EntryState> {
  const deadline = Date.now() + timeoutMs
  let last: EntryState | null = null
  while (Date.now() < deadline) {
    await refreshFixture(ui, 'entry')
    last = await readEntry(ui, cardSelector)
    if (last.present && predicate(last)) return last
    await sleep(POLL_MS)
  }
  throw new Error('等待入口件状态超时（' + label + '）：last=' + JSON.stringify(last))
}

/** 刷新安装按钮后轮询目标档（按钮只在任务期自轮询）。 */
async function waitForInstallButtonAfterRefresh(ui: UiHandle, cardSelector: string, predicate: (state: InstallButtonState) => boolean, label: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<InstallButtonState> {
  const deadline = Date.now() + timeoutMs
  let last: InstallButtonState | null = null
  while (Date.now() < deadline) {
    await refreshFixture(ui, 'button')
    last = await readInstallButton(ui, cardSelector)
    if (last.present && predicate(last)) return last
    await sleep(POLL_MS)
  }
  throw new Error('等待安装按钮状态超时（' + label + '）：last=' + JSON.stringify(last))
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
  // pnpm 的 registry 元数据缓存（cache-dir）默认是用户全局目录，键里带 registry origin（含端口）：
  // 与本 run 复用了同一端口的旧 run 会把旧 integrity 带进来，表现为 ERR_PNPM_TARBALL_INTEGRITY
  // （2026-11-03T082230 实测：51013 端口命中 11-02 的 fixture-a packument，B9Btt vs v/wvcm）。
  // 所以 cache-dir 也必须按 run 隔离，和 store 一样从 profile 建好前就生效。
  const cacheDir = join(run.layout.root, 'pnpm-cache')
  await ensureDir(cacheDir)
  process.env['pnpm_config_cache_dir'] = cacheDir
  process.env['npm_config_cache'] = join(run.layout.root, 'npm-cache')
  // 产品取更新日志要求 dist.tarball 是 https 且与 registry 同源（src/core/changelog/io.ts:347-359），
  // 所以产品侧的 registry 一律走本 run 的 TLS 前置；verdaccio 仍是仓库外 http，只当上游。
  const front = await startTlsRegistryFront({ upstreamBaseUrl: fixtureEnv.registry.baseUrl, certificateDir: join(run.layout.root, 'tls-registry-front') })
  run.registerPort('tls-registry-front', front.port)
  const ctx: KContext = { run, mode: options.mode, homeDir, osHomeDir, profileName: PROFILE_NAME, registryUrl: front.baseUrl, front, gens: [], host: null, ui: null }
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
async function startHostGen(ctx: KContext, label: string, options: { delayMs?: number; match?: 'pnpm-user-agent' | 'all'; withUi?: boolean } = {}): Promise<HostGen> {
  const delayMs = options.delayMs && options.delayMs > 0 ? options.delayMs : null
  ctx.front.setDelay(delayMs === null ? null : { delayMs, match: options.match ?? 'pnpm-user-agent' })
  const requestsFrom = ctx.front.requests().length
  const host = await startCliHost({
    homeDir: ctx.homeDir,
    osHomeDir: ctx.osHomeDir,
    profileName: PROFILE_NAME,
    // 产品侧 registry = 本 run 的 TLS 前置；自签证书靠 NODE_EXTRA_CA_CERTS 注入宿主与它 spawn 的 CLI/pnpm。
    extraEnv: { DSH_SELFTEST_REGISTRY: ctx.registryUrl, NODE_EXTRA_CA_CERTS: ctx.front.certPath },
  })
  ctx.run.registerProcess(label + '-host', host.pid() ?? null)
  ctx.run.registerPort(label + '-host-port', host.port)
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
  const frontRequests = ctx.front.requests()
  await ctx.run.raw('tls-front-stop', { port: ctx.front.port, requests: frontRequests.length, delayed: ctx.front.delayedCount(), certSha256: ctx.front.certSha256 })
  await ctx.front.stop().catch(() => undefined)
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
async function ledgerJobsOf(ctx: KContext, packageName: string): Promise<LedgerEntry[]> {
  const entries = await ledgerStates(ctx)
  return entries.filter((entry) => isLedgerPathOf(entry.file, packageName)).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 台账里某插件最新一份记录（找不到 null）。状态目录按插件+profile 派生，同一组合只有一份 state.json（重试覆盖）。 */
async function ledgerFor(ctx: KContext, packageName: string): Promise<LedgerEntry | null> {
  const hits = await ledgerJobsOf(ctx, packageName)
  return hits.length > 0 ? hits[0] as LedgerEntry : null
}

/** 台账记录是否成功终态（completed / restart-required）。 */
function isSuccessLedger(entry: LedgerEntry | null): boolean {
  return entry !== null && SUCCESS_STATES.indexOf(ledgerStateOf(entry) as typeof SUCCESS_STATES[number]) >= 0
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

/** 把 LogEventRecord 转成 auditInstallFails 期待的 fact 形状。 */
function asAuditFacts(events: readonly LogEventRecord[]): { namespace: string; event: string; level: string; fields: Record<string, unknown> }[] {
  return events.map((event) => ({ namespace: (event.source || '').split('/')[0], event: event.event, level: event.level || '', fields: event.fields }))
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

/** 异步跑 dsh CLI：同步 spawnSync 会堵死本进程事件循环，TLS registry 前置（同进程 HTTPS 服务）会因此无法响应 pnpm 的下载请求（K2 手工命令需要它活着）。 */
interface AsyncCliResult {
  readonly exitCode: number | null
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

function runDshCliAsync(args: readonly string[], options: { homeDir: string; timeoutMs?: number; extraEnv?: Record<string, string | undefined> }): Promise<AsyncCliResult> {
  const fullArgs = ['--expose-internals', DSH_PATHS.cliJsPath, ...args]
  const started = Date.now()
  const timeoutMs = options.timeoutMs || 600000
  return new Promise((resolve) => {
    const child = spawn(DSH_PATHS.exePath, fullArgs, {
      cwd: options.homeDir,
      env: dshCliEnv({ homeDir: options.homeDir, extraEnv: options.extraEnv }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else child.kill()
    }, timeoutMs)
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += Buffer.from(chunk).toString('utf8') })
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += Buffer.from(chunk).toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: null, durationMs: Date.now() - started, stdout, stderr: stderr + String(error), timedOut })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, durationMs: Date.now() - started, stdout, stderr, timedOut })
    })
  })
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

  const gen1 = await startHostGen(ctx, 'k1-gen1', { delayMs: 6000, match: 'pnpm-user-agent' })
  const ui1 = uiOf(gen1)
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind !== 'loading', 'A 面板状态回填（非 loading）')
  const cInitial = await waitForPanel(ui1, cardA, panelC, (state) => state.banner !== null && state.banner.kind !== 'loading', 'C 额外面板状态回填（非 loading）')
  const initial = (await readPanel(ui1, cardA, panelA)) as PanelState
  await waitForEntry(ui1, cardA, (state) => state.present && state.variant === 'badge', '入口初始挂载（badge）')
  const entryInitial = await waitForEntryAfterRefresh(ui1, cardA, (state) => state.state === 'idle' && state.ariaLabel === '已是最新 0.0.1', '入口初始已是最新 0.0.1（refresh）')
  const buttonInitial = await waitForInstallButton(ui1, cardA, (state) => state.present && state.kind !== null, '安装按钮挂载')
  const initialDone = initial.banner !== null && initial.banner.kind === 'done' && initial.banner.title === '已是最新，无需更新。'
  const initialEntryOk = entryInitial.present && entryInitial.variant === 'badge' && entryInitial.state === 'idle' && entryInitial.ariaLabel === '已是最新 0.0.1'
  const initialOk = initialDone && cInitial.banner !== null && cInitial.banner.kind === 'idle' && cInitial.banner.title === '未安装' && initialEntryOk && buttonInitial.kind === 'loading' && buttonInitial.buttons.some((button) => button.action === 'check')
  await capture(ctx.run, ui1, {
    step: 'k1-10-initial',
    what: 'A 单包面板初始（未查更新）+ 额外面板绑未安装的 C + 安装按钮 + 入口',
    expected: 'A 横幅「已是最新，无需更新。」；C 横幅「未安装」+「检查更新」；安装按钮 loading 档（挂载未查、含检查动作）；入口 badge + aria「已是最新 0.0.1」',
    actual: 'A=' + JSON.stringify(initial.banner) + '；C=' + JSON.stringify(cInitial.banner) + '；按钮 kind=' + String(buttonInitial.kind) + '；入口=' + JSON.stringify({ variant: entryInitial.variant, state: entryInitial.state, ariaLabel: entryInitial.ariaLabel }),
    verdict: initialOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-11-panel-done', what: '已安装且未查更新时单包面板显示已了结', expected: 'banner.kind=done、标题「已是最新，无需更新。」', actual: JSON.stringify(initial.banner), ok: initialDone })
  rec({ step: 'k1-12-c-not-installed', what: '额外面板指向未安装的 C：显示未安装与检查动作', expected: 'banner.kind=idle、标题「未安装」、有 check 动作', actual: JSON.stringify(cInitial.banner) + '；actions=' + JSON.stringify(cInitial.actions.map((item) => item.action)), ok: cInitial.banner !== null && cInitial.banner.kind === 'idle' && cInitial.banner.title === '未安装' && cInitial.actions.some((item) => item.action === 'check') })
  rec({ step: 'k1-13-install-button-loading', what: '安装按钮挂载后（autoCheck=never）未查询时呈 loading 档，并给检查动作', expected: 'kind=loading、status「正在读取更新状态…」、buttons 含 action=check', actual: JSON.stringify({ kind: buttonInitial.kind, status: buttonInitial.status, buttons: buttonInitial.buttons.map((item) => item.action) }), ok: buttonInitial.kind === 'loading' && buttonInitial.buttons.some((button) => button.action === 'check') })
  rec({ step: 'k1-14-entry-idle', what: '单包入口初始态为 badge + idle（aria-label 给「已是最新 0.0.1」，badge 无可见正文）', expected: 'variant=badge、state=idle、aria-label=「已是最新 0.0.1」', actual: JSON.stringify(entryInitial), ok: initialEntryOk })

  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  const updating = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', '可更新横幅')
  const withChangelog = await waitForChangelog(ui1, cardA, panelA, FIXTURE_VARIANT_VERSION)
  const entryUpdate = await waitForEntryAfterRefresh(ui1, cardA, (state) => state.state === 'update' && state.ariaLabel.indexOf('有新版本 0.0.2') >= 0, '入口可更新档（refresh）')
  await clickInCard(ui1, cardA, '.dsh-upd-ib button[data-action="check"]')
  const buttonUpdate = await waitForInstallButton(ui1, cardA, (state) => state.kind === 'update' && state.buttons.some((button) => button.action === 'install'), '安装按钮可更新档（点按钮自身检查）')
  const updateOk = updating.banner !== null && updating.banner.title === '有新版本 0.0.2 可安装（当前版本 0.0.1）。' && updating.actions.some((item) => item.action === 'install')
  await capture(ctx.run, ui1, {
    step: 'k1-20-update',
    what: '点「检查更新」后：可更新横幅 + 安装动作 + 版本条 + 入口',
    expected: '横幅「有新版本 0.0.2 可安装（当前版本 0.0.1）。」、有 install 动作、入口 update 档',
    actual: JSON.stringify(updating.banner) + '；strip=' + JSON.stringify(updating.strip) + '；actions=' + JSON.stringify(updating.actions.map((item) => item.action)) + '；入口=' + JSON.stringify({ state: entryUpdate.state, ariaLabel: entryUpdate.ariaLabel }),
    verdict: updateOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-21-update-banner', what: '可更新横幅原文与动作', expected: '标题精确等于「有新版本 0.0.2 可安装（当前版本 0.0.1）。」且含 install', actual: JSON.stringify(updating.banner) + '；actions=' + JSON.stringify(updating.actions.map((item) => item.action)), ok: updateOk })
  rec({ step: 'k1-22-entry-update', what: '入口切到 update 档', expected: 'state=update 且 aria-label 含「有新版本 0.0.2」', actual: JSON.stringify(entryUpdate), ok: entryUpdate.state === 'update' && entryUpdate.ariaLabel.indexOf('有新版本 0.0.2') >= 0 })
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

  // 安装从「安装按钮」自身的安装动作发起（按钮的 busy/done 档来自它自己的任务态；autoCheck=never 时按钮不会观测别人发起的任务）。
  await clickInCard(ui1, cardA, '.dsh-upd-ib button[data-action="install"]')
  const busy = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'busy', '安装中横幅', 60000)
  const entryBusy = await waitForEntryAfterRefresh(ui1, cardA, (state) => state.state === 'busy' && state.ariaLabel.indexOf('正在安装') >= 0, '入口安装中档（refresh）', 60000)
  const buttonBusy = await waitForInstallButton(ui1, cardA, (state) => state.kind === 'busy', '安装按钮安装中档', 60000)
  const busyOk = busy.banner !== null && busy.banner.title === '正在安装 0.0.2…关闭面板不会中断。'
  await capture(ctx.run, ui1, {
    step: 'k1-30-installing',
    what: '安装进行中：忙碌横幅 + 禁用动作 + 入口/安装按钮 busy 档',
    expected: '横幅「正在安装 0.0.2…关闭面板不会中断。」、安装动作禁用、入口「正在安装…」',
    actual: JSON.stringify(busy.banner) + '；actions=' + JSON.stringify(busy.actions.map((item) => ({ action: item.action, disabled: item.disabled }))) + '；入口=' + JSON.stringify({ state: entryBusy.state, ariaLabel: entryBusy.ariaLabel }),
    verdict: busyOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-35-busy-banner', what: '安装中横幅原文', expected: '标题精确等于「正在安装 0.0.2…关闭面板不会中断。」', actual: JSON.stringify(busy.banner), ok: busyOk })
  rec({ step: 'k1-36-busy-entry', what: '入口切 busy 档', expected: 'state=busy、aria-label「正在安装…」', actual: JSON.stringify(entryBusy), ok: entryBusy.state === 'busy' && entryBusy.ariaLabel === '正在安装…' })
  rec({ step: 'k1-37-busy-install-button', what: '安装按钮切 busy 档', expected: 'kind=busy', actual: String(buttonBusy.kind), ok: buttonBusy.kind === 'busy' })

  await waitDiskVersions(ctx, { [packageA]: FIXTURE_VARIANT_VERSION }, 'K1 A 装到 0.0.2')
  // 产品真相（实测 274-20261103T061248 raw/43 日志）：换包完成后宿主半重载，reader 读到运行版本=磁盘版本，
  // 单包面板直接落定为「已是最新，无需更新。」；「待重启」只在旧 reader 实例仍握在飞任务的毫秒级窗口出现，
  // 不能作为稳定 UI 证据（批量面板的待重启由 jobState 另行给出，K3 覆盖）。这里断言落定终态。
  const settled = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', '安装落定（已是最新）', 180000)
  const settledEntry = await waitForEntryAfterRefresh(ui1, cardA, (state) => (state.state === 'idle' && state.ariaLabel.indexOf('已是最新') >= 0 && state.ariaLabel.indexOf(FIXTURE_VARIANT_VERSION) >= 0) || (state.state === 'restart' && state.ariaLabel === '待重启'), '入口落定（已是最新 0.0.2 或待重启）', 60000)
  const settledOk = settled.banner !== null && settled.banner.title === '已是最新，无需更新。'
  const settledEntryOk = (settledEntry.state === 'idle' && settledEntry.ariaLabel.indexOf('已是最新') >= 0 && settledEntry.ariaLabel.indexOf(FIXTURE_VARIANT_VERSION) >= 0) || (settledEntry.state === 'restart' && settledEntry.ariaLabel === '待重启')
  await capture(ctx.run, ui1, {
    step: 'k1-40-settled',
    what: '安装完成落定：面板已了结 + 入口已是最新 0.0.2（换包后宿主半重载，运行版本=磁盘版本）',
    expected: '横幅「已是最新，无需更新。」、入口 idle 且 note 含「已是最新 0.0.2」',
    actual: JSON.stringify(settled.banner) + '；入口=' + JSON.stringify({ state: settledEntry.state, ariaLabel: settledEntry.ariaLabel }),
    verdict: settledOk && settledEntryOk ? 'pass' : 'fail',
  })
  rec({ step: 'k1-41-settled-banner', what: '安装落定后面板原文', expected: '标题精确等于「已是最新，无需更新。」', actual: JSON.stringify(settled.banner), ok: settledOk })
  rec({ step: 'k1-42-settled-entry', what: '安装落定后入口读数（已是最新 0.0.2 或待重启）', expected: 'state=idle 且 aria「已是最新 0.0.2」，或 state=restart 且 aria「待重启」', actual: JSON.stringify(settledEntry), ok: settledEntryOk })

  // 装的是「提供面板/安装按钮的插件本体」（A 自更新），安装期插件宿主半会重载：单包路径下 exec/verify 日志行会随旧日志口一起消失，
  // 后端事实以磁盘 + updates/<pluginId>/<jobId>/{before,state}.json 台账为准（批量路径的日志 in K3/K4 完整）。
  const ledgerA1 = await waitForLedger(ctx, packageA, ['completed', 'restart-required'], 'K1 A 台账落定（停宿主前）', INSTALL_TIMEOUT_MS)
  const diskAfterInstall = await diskVersions(ctx, [packageA])
  await stopHostGen(ctx, gen1, 'k1-before-restart')
  const events1 = await readEvents(ctx)
  const execs1 = installExecsOf(events1, packageA)
  const fails1 = installFailsOf(events1, packageA)
  const requests1 = eventsNamed(events1, 'update.install.request')
  const attemptDir = ledgerA1 !== null ? join(ctx.homeDir, 'updates', ledgerA1.file.slice(0, ledgerA1.file.lastIndexOf('/'))) : null
  let beforeJson: Record<string, unknown> | null = null
  if (attemptDir !== null) {
    try {
      beforeJson = JSON.parse(await readFile(join(attemptDir, 'before.json'), 'utf8')) as Record<string, unknown>
    } catch {
      beforeJson = null
    }
  }
  await ctx.run.raw('k1-gen1-logs', { execs: execs1, fails: fails1, requests: requests1, ledger: ledgerA1 ? { file: ledgerA1.file, state: ledgerA1.state } : null, before: beforeJson, disk: diskAfterInstall })
  const ledgerState1 = ledgerStateOf(ledgerA1)
  const requestOk = requests1.length === 1
  rec({ step: 'k1-43-install-request-once', what: '单包安装只发起一次安装请求（UI 真实点击安装按钮触发）', expected: 'A 的 update.install.request 恰 1 条、无 update.install.fail', actual: 'requests=' + String(requests1.length) + ' fails=' + String(fails1.length) + '；request=' + JSON.stringify(requests1[0] ? requests1[0].fields : null), ok: requestOk && fails1.length === 0 })
  const beforeOk = beforeJson !== null && beforeJson['previousVersion'] === '0.0.1' && String(beforeJson['jobId'] || '') === String(ledgerA1 !== null ? ledgerA1.state['id'] : '')
  rec({ step: 'k1-44-ledger-snapshot', what: '受保护安装：安装前快照 before.json 记录旧版 0.0.1 且 jobId 与台账一致', expected: 'before.previousVersion=0.0.1、before.jobId===state.id', actual: JSON.stringify(beforeJson ? { previousVersion: beforeJson['previousVersion'], jobId: beforeJson['jobId'], files: Object.keys((beforeJson['files'] as Record<string, unknown>) || {}) } : null) + '；state.id=' + String(ledgerA1 !== null ? ledgerA1.state['id'] : null), ok: beforeOk })
  rec({ step: 'k1-45-ledger-settled', what: '台账逐行真相：目标 0.0.2、状态为落定档（completed 或 restart-required）', expected: 'state∈{completed,restart-required}、targetVersion=0.0.2、previousVersion=0.0.1', actual: JSON.stringify(ledgerA1 ? { state: ledgerState1, targetVersion: ledgerA1.state['targetVersion'], previousVersion: ledgerA1.state['previousVersion'] } : null), ok: ledgerState1 === 'completed' || ledgerState1 === 'restart-required' })
  rec({ step: 'k1-46-disk-after-install', what: '磁盘装到 0.0.2', expected: 'A 磁盘版本=0.0.2', actual: JSON.stringify(diskAfterInstall), ok: diskAfterInstall[packageA] === FIXTURE_VARIANT_VERSION })

  const gen2 = await startHostGen(ctx, 'k1-gen2')
  const ui2 = uiOf(gen2)
  const done = await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', '重启后已了结', 180000)
  const tagsAfter = await readCardTags(ui2, cardA)
  const entryDone = await waitForEntryAfterRefresh(ui2, cardA, (state) => state.state === 'idle' && state.ariaLabel.indexOf('已是最新') >= 0 && state.ariaLabel.indexOf(FIXTURE_VARIANT_VERSION) >= 0, '重启后入口已是最新 0.0.2（refresh）')
  const buttonDone = await waitForInstallButtonAfterRefresh(ui2, cardA, (state) => state.kind === 'done', '重启后安装按钮 done（refresh）')
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
  rec({ step: 'k1-54-entry-done', what: '入口已是最新（aria-label）', expected: 'state=idle、aria-label 含「已是最新 0.0.2」', actual: JSON.stringify(entryDone), ok: entryDone.state === 'idle' && entryDone.ariaLabel.indexOf('已是最新') >= 0 && entryDone.ariaLabel.indexOf('0.0.2') >= 0 })
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
    expected: 'versionDocUnchanged=true、sha256Before≠sha256After、改坏前后 tarball URL 都回 200 且响应字节数一致（存储文件字节数只是参考，HTTP 响应可能走压缩/包装）',
    actual: JSON.stringify({ versionDocUnchanged: fault.versionDocUnchanged, shaChanged: fault.sha256Before !== fault.sha256After, servedBeforeStatus: fault.servedBeforeStatus, servedAfterStatus: fault.servedAfterStatus, servedBeforeBytes: fault.servedBeforeBytes, servedAfterBytes: fault.servedAfterBytes, sizeBytes: fault.sizeBytes }),
    ok: fault.versionDocUnchanged === true && fault.sha256Before !== fault.sha256After && fault.servedBeforeStatus === 200 && fault.servedAfterStatus === 200 && fault.servedBeforeBytes === fault.servedAfterBytes,
  })

  const gen1 = await startHostGen(ctx, 'k2-gen1')
  const ui1 = uiOf(gen1)
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null, 'A 卡片挂载（单包面板出现）')
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

  await clickInCard(ui1, cardA, '.dsh-upd-ib button[data-action="check"]')
  await waitForInstallButton(ui1, cardA, (state) => state.kind === 'update' && state.buttons.some((button) => button.action === 'install'), '安装按钮可更新档（点按钮自身检查）', 60000)
  // 失败由安装按钮自身发起：按钮的失败档来自它自己的任务锁存。
  await clickInCard(ui1, cardA, '.dsh-upd-ib button[data-action="install"]')
  const failed = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'failed', '安装失败横幅', INSTALL_TIMEOUT_MS)
  await sleep(500)
  const failedFull = (await readPanel(ui1, cardA, panelA)) as PanelState
  const entryFailed = await waitForEntryAfterRefresh(ui1, cardA, (state) => state.state === 'failed', '入口失败档（refresh）', 60000)
  const buttonFailed = await waitForInstallButton(ui1, cardA, (state) => state.kind === 'failed', '安装按钮失败档', 60000)
  const failBanner = failed.banner
  const failTitle = failBanner ? failBanner.title : ''
  const failSub = failBanner ? failBanner.sub : ''
  const lastResort = failedFull.lastResort
  const manual = failedFull.manual
  const manualCode = manual && manual.code ? manual.code : ''
  const failBannerOk = failBanner !== null && failTitle.indexOf('更新失败（install-failed）') === 0 && failedFull.errCode === 'install-failed'
  const lastResortOk = !!lastResort && lastResort.present && lastResort.badge === '最后手段' && lastResort.status === '自动恢复不可用' && lastResort.reason === '没有可用的自动数据路径；复制这条命令是唯一出路。'
  const manualHeadingOk = !!manual && manual.present && manual.heading === '手工备用命令（请复制整行执行）：'
  const manualCommandOk = /^dsh plugin --profile t10ui add --save-exact \S+@0\.0\.2 --registry=https:\/\/127\.0\.0\.1:\d+\/?$/.test(manualCode)
  const entryFailedOk = entryFailed.state === 'failed' && entryFailed.ariaLabel === '更新失败，请查看详情'
  const buttonFailedOk = buttonFailed.kind === 'failed'
  await capture(ctx.run, ui1, {
    step: 'k2-20-failure-last-resort',
    what: '安装失败：失败横幅 + 最后手段条 + 手工备用命令（当帧可信）+ 入口/安装按钮失败档',
    expected: '横幅标题以「更新失败（install-failed）」开头、最后手段三字段原文、手工命令形状 --profile t10ui add --save-exact <pkg>@0.0.2 --registry=<本 run registry>、入口「更新失败，请查看详情」、按钮 kind=failed',
    actual: JSON.stringify({ banner: failBanner, errCode: failedFull.errCode, lastResort, manual: manual ? { heading: manual.heading, code: manual.code, neutral: manual.neutral } : null, entry: { state: entryFailed.state, ariaLabel: entryFailed.ariaLabel }, buttonKind: buttonFailed.kind }),
    verdict: failBannerOk && lastResortOk && manualHeadingOk && manualCommandOk && entryFailedOk && buttonFailedOk ? 'pass' : 'fail',
  })
  rec({ step: 'k2-03-failure-banner', what: '失败横幅标题与错误码一致', expected: '标题以「更新失败（install-failed）」开头、errCode=install-failed', actual: JSON.stringify({ title: failTitle, sub: failSub, errCode: failedFull.errCode }), ok: failBannerOk })
  rec({ step: 'k2-04-last-resort', what: '最后手段条只在「无自动救援 + 命令当帧可信」时出现，原文三字段', expected: 'badge=最后手段、status=自动恢复不可用、reason=「没有可用的自动数据路径；复制这条命令是唯一出路。」', actual: JSON.stringify(lastResort), ok: lastResortOk })
  rec({ step: 'k2-05-manual-command', what: '手工备用命令原文（与命令形状对齐、registry 指向本 run）', expected: '标题「手工备用命令（请复制整行执行）：」+ 命令行匹配 dsh plugin --profile t10ui add --save-exact <pkg>@0.0.2 --registry=https://127.0.0.1:<port>', actual: JSON.stringify({ heading: manual ? manual.heading : null, code: manualCode, neutral: manual ? manual.neutral : null }), ok: manualHeadingOk && manualCommandOk })
  rec({ step: 'k2-06-entry-failed', what: '入口随安装失败落到失败档', expected: 'state=failed、aria-label「更新失败，请查看详情」', actual: JSON.stringify(entryFailed), ok: entryFailedOk })
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
  // 失败尝试在 run 私有 pnpm store 里留下了 integrity 不匹配的 tarball 缓存（重试退避可长达数分钟）；
  // 手工命令必须走一个全新的 store 目录，否则 restore 之后仍会反复重试坏缓存。
  const manualResult = await runDshCliAsync(tokens.slice(1), {
    homeDir: ctx.homeDir,
    timeoutMs: 600000,
    extraEnv: { NODE_EXTRA_CA_CERTS: ctx.front.certPath, npm_config_store_dir: join(ctx.run.layout.root, 'pnpm-store-manual') },
  })
  await ctx.run.raw('k2-manual-command-exec', { command: manualCode, argv: tokens.slice(1), exitCode: manualResult.exitCode, durationMs: manualResult.durationMs, stdoutTail: manualResult.stdout.slice(-6000), stderrTail: manualResult.stderr.slice(-6000) })
  const diskFixed = await diskVersions(ctx, [packageA])
  rec({ step: 'k2-13-manual-exec', what: '停宿主后照面板给出的手工命令原文执行，exit=0 且磁盘装到 0.0.2', expected: 'exitCode=0 且 A 磁盘版本=0.0.2', actual: JSON.stringify({ exitCode: manualResult.exitCode, disk: diskFixed, durationMs: manualResult.durationMs }), ok: manualResult.exitCode === 0 && diskFixed[packageA] === FIXTURE_VARIANT_VERSION })

  const gen2 = await startHostGen(ctx, 'k2-gen2')
  const ui2 = uiOf(gen2)
  await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null, 'gen2 A 卡片挂载（单包面板出现）', 180000)
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

/** K3：三包批量面板全状态 —— 挂载自动检查 / 可更新 / 安装中 / 部分失败隔离 / 重启续跑 / 最终一致。
 *
 * 坏包选最后一行 C：坏 tarball 会让该次 pnpm 在 profile 上留下 0.0.2 依赖边，
 * 若坏 B 则后续 C 的 pnpm 重解也会失败（本 run 首跑 074734 实测），隔离性无法归因到「坏行本身」。
 * C 是最后一行，A/B 成功行不受它的坏 tarball 影响，失败隔离与续跑都可以干净观测。
 */
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
  await waitForBatchSeat(live(), 'a', (state) => state.card.present && state.panel.present, { label: 'A 批量卡片挂载（面板出现）', timeoutMs: 180000, intervalMs: 500 })
  const mountSeat = await waitForBatchSeat(live(), 'a', (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3, { label: 'A 批量面板三行挂载', timeoutMs: 180000, intervalMs: 300 })
  const mountRows = mountSeat.panel.rows
  const mountKeys = mountRows.map((row) => row.key).join(',')
  const mountConsistent = mountKeys === 'a,b,c' && mountRows.every((row) => row.phase !== null)
  await capture(ctx.run, ui1, {
    step: 'k3-10-mount',
    what: '批量面板挂载首帧：三行 a/b/c 与总账/台账（产品默认「打开面板时自动检查」，「尚未查询」只存在于自动检查完成前的首帧）',
    expected: 'rows=a,b,c；行相位/总账/台账自洽（自动检查前或检查后均可，但不得出现与磁盘不符的「已是最新」）',
    actual: 'rows=' + mountKeys + '；phases=' + JSON.stringify(mountRows.map((row) => row.phase)) + '；summary=' + JSON.stringify(mountSeat.panel.summary) + '；ledger=' + JSON.stringify(mountSeat.panel.ledger),
    verdict: mountConsistent ? 'pass' : 'fail',
  })
  rec({ step: 'k3-01-mount-rows', what: '批量面板挂载即有三行 a/b/c（顺序稳定）', expected: '三行 key=a,b,c 且相位已渲染', actual: 'rows=' + mountKeys + '；phases=' + JSON.stringify(mountRows.map((row) => row.phase)), ok: mountConsistent })
  rec({ step: 'k3-02-auto-check-on-open', what: '产品默认打开面板即自动检查（初始「尚未查询」只是首帧，不能当稳定态断言）', expected: 'summary 非空且报「待查询/检查中/可更新」之一；若报可更新，行 versionNew=0.0.2', actual: 'summary=' + JSON.stringify(mountSeat.panel.summary) + '；ledger=' + JSON.stringify(mountSeat.panel.ledger), ok: (mountSeat.panel.summary || '').length > 0 })

  // ---- 1. 等自动检查完成：三行可更新 0.0.2 且「全部更新」可点 ----
  const readySeat = await waitForBatchSeat(live(), 'a', (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => row.versionNew === FIXTURE_VARIANT_VERSION) && state.panel.install !== null && state.panel.install.disabled === false, { label: '批量检查完成且「全部更新」可点', timeoutMs: 180000, intervalMs: 300 })
  const readyRows = readySeat.panel.rows
  const readyOk = readyRows.length === 3 && readyRows.every((row) => row.versionCur === FIXTURE_BASE_VERSION && row.versionNew === FIXTURE_VARIANT_VERSION)
  const readySummaryOk = (readySeat.panel.summary || '').indexOf('3 个可更新') >= 0 && (readySeat.panel.ledger || '').indexOf('3 个可更新') >= 0
  await capture(ctx.run, ui1, {
    step: 'k3-20-ready',
    what: '检查更新后：三行都列出 0.0.1 → 0.0.2，总账「3 个可更新」，「全部更新」可点',
    expected: '每行 cur=0.0.1、new=0.0.2；summary 含「3 个可更新」；ledger 含「3 个可更新」；install 宏可点',
    actual: 'rows=' + JSON.stringify(readyRows.map((row) => ({ key: row.key, cur: row.versionCur, next: row.versionNew, phase: row.phase }))) + '；summary=' + JSON.stringify(readySeat.panel.summary) + '；ledger=' + JSON.stringify(readySeat.panel.ledger) + '；installDisabled=' + String(readySeat.panel.install ? readySeat.panel.install.disabled : null),
    verdict: readyOk && readySummaryOk ? 'pass' : 'fail',
  })
  rec({ step: 'k3-03-ready-rows', what: '检查更新后三行的当前/新版本', expected: '三行 cur=0.0.1、new=0.0.2', actual: JSON.stringify(readyRows.map((row) => ({ key: row.key, cur: row.versionCur, next: row.versionNew }))), ok: readyOk })
  rec({ step: 'k3-04-ready-summary', what: '就绪态总账/台账一致', expected: 'summary 含「3 个可更新」；ledger 含「3 个可更新」', actual: 'summary=' + JSON.stringify(readySeat.panel.summary) + '；ledger=' + JSON.stringify(readySeat.panel.ledger), ok: readySummaryOk })

  // ---- 2. 注入：检查之后、安装之前改坏 C@0.0.2 tarball 字节（元数据/integrity 不动 ⇒ check 过、install 必失败） ----
  const corruption = await corruptPublishedTarball({ registry: fixtureEnv.registry, backupDir: join(ctx.run.layout.rawDir, 'k3-corrupt-c'), packageName: packageC, version: FIXTURE_VARIANT_VERSION })
  await ctx.run.raw('k3-registry-tarball-corrupted', corruption)
  rec({ step: 'k3-05-fault-injection', what: '改坏 C 的 tarball 字节（元数据一字不动）', expected: 'servedBefore/After=200；大小不变；sha256 变了；versionDocUnchanged=true', actual: JSON.stringify({ servedBefore: corruption.servedBeforeStatus, servedAfter: corruption.servedAfterStatus, sizeBytes: corruption.sizeBytes, sha256Before: corruption.sha256Before, sha256After: corruption.sha256After, versionDocUnchanged: corruption.versionDocUnchanged }), ok: corruption.servedBeforeStatus === 200 && corruption.servedAfterStatus === 200 && corruption.sha256Before !== corruption.sha256After && corruption.versionDocUnchanged })

  // ---- 3. 真 UI 点「全部更新」→ 拍安装中窗（只读 DOM 一瞬，之后改轮询磁盘/台账） ----
  await clickSeatAction(live(), 'a', 'install')
  let installingSeat: BatchSeatState | null = null
  try {
    installingSeat = await waitForBatchSeat(live(), 'a', (state) => {
      const running = state.panel.rows.some((row) => row.phase === 'installing' || row.queued === true || (row.status !== null && row.status.indexOf('正在安装') >= 0))
      return running || (state.panel.summary || '').indexOf('安装中') >= 0 || (state.panel.ledger || '').indexOf('安装中') >= 0
    }, { label: 'K3 安装中窗（行 installing/queued 或总账含安装中）', timeoutMs: 30000, intervalMs: 200 })
  } catch {
    installingSeat = null
  }
  const installingState = installingSeat !== null ? installingSeat : await readBatchSeat(live(), 'a').catch(() => null)
  const installingOk = installingState !== null && (installingState.panel.rows.some((row) => row.phase === 'installing' || row.queued === true) || (installingState.panel.summary || '').indexOf('安装中') >= 0 || (installingState.panel.ledger !== null && installingState.panel.ledger.indexOf('安装中') >= 0))
  await capture(ctx.run, ui1, {
    step: 'k3-30-installing',
    what: '宏「全部更新」后：批量面板进入安装中（行 installing/queued，总账报安装中）',
    expected: '存在 installing/queued 行或总账含「安装中」；安装宏禁用',
    actual: installingState === null ? '(面板读数不可用)' : 'rows=' + JSON.stringify(installingState.panel.rows.map((row) => ({ key: row.key, phase: row.phase, queued: row.queued, status: row.status }))) + '；summary=' + JSON.stringify(installingState.panel.summary) + '；ledger=' + JSON.stringify(installingState.panel.ledger),
    verdict: installingOk ? 'pass' : 'unknown',
  })
  rec({ step: 'k3-06-installing', what: '安装窗：批量面板如实显示安装中', expected: '存在 installing/queued 行或 summary/ledger 含「安装中」', actual: installingState === null ? 'null' : JSON.stringify({ rows: installingState.panel.rows.map((row) => ({ key: row.key, phase: row.phase, queued: row.queued })), summary: installingState.panel.summary, ledger: installingState.panel.ledger }), ok: installingOk })

  // ---- 4. 安装窗：只轮询磁盘 + 台账（C 坏 tarball 必失败、A/B 照常完成） ----
  const partialDeadline = Date.now() + INSTALL_TIMEOUT_MS
  const observed: string[] = []
  let lastDisk: Record<string, string | null> = {}
  let lastLedgerBad: LedgerEntry | null = null
  let partialSettled = false
  while (Date.now() < partialDeadline) {
    lastDisk = await diskVersions(ctx, [packageA, packageB, packageC])
    lastLedgerBad = await ledgerFor(ctx, packageC)
    const aOk = lastDisk[packageA] === FIXTURE_VARIANT_VERSION
    const bOk = lastDisk[packageB] === FIXTURE_VARIANT_VERSION
    const badFailed = ledgerStateOf(lastLedgerBad) === 'failed'
    const snapshot = 'a=' + String(lastDisk[packageA]) + ',b=' + String(lastDisk[packageB]) + ',c=' + String(lastDisk[packageC]) + ',cLedger=' + ledgerStateOf(lastLedgerBad)
    if (observed.length === 0 || observed[observed.length - 1] !== snapshot) observed.push(snapshot)
    if (aOk && bOk && badFailed) {
      partialSettled = true
      break
    }
    await sleep(1000)
  }
  await ctx.run.raw('k3-partial-settled', { partialSettled, disk: lastDisk, ledgerC: { state: ledgerStateOf(lastLedgerBad), target: lastLedgerBad ? lastLedgerBad.state['targetVersion'] : null }, observed: observed.slice(-10) })
  // 等面板把安装中收干净、失败横幅渲染出来（安装窗结束后面板会重排一次）。
  const failureSeat = await waitForBatchSeat(live(), 'a', (state) => {
    if (state.panel.rows.length < 3) return false
    const noRunning = state.panel.rows.every((row) => row.phase !== 'installing' && row.queued !== true)
    const rowC = state.panel.rows.find((row) => row.key === 'c') || null
    return noRunning && rowC !== null && rowC.phase === 'failed'
  }, { label: '部分失败后面板重排完成（C 行 failed、无安装中行）', timeoutMs: 180000, intervalMs: 500 }).catch(() => null)
  await sleep(1500)
  const failurePanel = failureSeat !== null ? failureSeat : await readBatchSeat(live(), 'a').catch(() => null)
  const failureExtras = await readBatchExtras(ui1, cardA).catch(() => null)
  const failureDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const ledgerPartial = await ledgerFor(ctx, packageC)
  const ledgerAPartial = await waitForLedger(ctx, packageA, SUCCESS_STATES as readonly string[], 'K3 A 台账成功终态（部分失败现场）', 90000)
  const ledgerBPartial = await waitForLedger(ctx, packageB, SUCCESS_STATES as readonly string[], 'K3 B 台账成功终态（部分失败现场）', 90000)
  const rowC = failurePanel !== null ? rowOfSeat(failurePanel, 'c') : null
  const rowsNoRunning = failurePanel !== null && failurePanel.panel.rows.every((row) => row.phase !== 'installing' && row.queued !== true)
  const badRowOk = rowC !== null && rowC.phase === 'failed' && (rowC.status || '').indexOf('最后手段') >= 0 && (rowC.status || '').indexOf('安装失败，请选择「重试」') >= 0 && (rowC.fail || '').indexOf('install-failed') >= 0
  const badRowRetryOk = rowC !== null && rowC.actions.indexOf('row-install') >= 0
  const failedBanner = failureExtras !== null ? failureExtras.failed : null
  const bannerOk = failedBanner !== null && failedBanner.title === '1 个插件安装失败。' && failedBanner.list.length === 1 && failedBanner.list[0].indexOf('夹具 C') >= 0 && failedBanner.rowline.indexOf('复制诊断') >= 0 && failedBanner.rowline.indexOf('复制手工命令') >= 0
  const failureSummary = failurePanel !== null ? (failurePanel.panel.summary || '') : ''
  const failureLedger = failurePanel !== null ? (failurePanel.panel.ledger || '') : ''
  const partialSummaryOk = failureSummary.indexOf('1 个插件安装失败') >= 0 && failureSummary.indexOf('安装中') < 0
  const partialLedgerOk = failureLedger.indexOf('1 个失败') >= 0 && failureLedger.indexOf('安装中') < 0
  const noFakeSuccess = failureSummary.indexOf('已全部为最新') < 0 && failureLedger.indexOf('3 个已是最新') < 0
  const diskPartialOk = failureDisk[packageA] === FIXTURE_VARIANT_VERSION && failureDisk[packageB] === FIXTURE_VARIANT_VERSION && failureDisk[packageC] === FIXTURE_BASE_VERSION
  const badLedgerPartialOk = ledgerStateOf(ledgerPartial) === 'failed' && ledgerPartial !== null && ledgerPartial.state['targetVersion'] === FIXTURE_VARIANT_VERSION
  const goodRowsOk = diskPartialOk && isSuccessLedger(ledgerAPartial) && isSuccessLedger(ledgerBPartial) && ledgerAPartial !== null && ledgerAPartial.state['targetVersion'] === FIXTURE_VARIANT_VERSION && ledgerBPartial !== null && ledgerBPartial.state['targetVersion'] === FIXTURE_VARIANT_VERSION
  await capture(ctx.run, ui1, {
    step: 'k3-40-partial-failure',
    what: '部分失败隔离：1 个失败横幅 + C 行最后手段可重试，A/B 照常完成；总账/台账不谎称全批成功',
    expected: '横幅「1 个插件安装失败。」名单含夹具 C、行内动作含「复制诊断/复制手工命令」；C 行 failed 且 status 含「最后手段」「安装失败，请选择「重试」」、fail 含 install-failed、有 row-install；summary 含「1 个插件安装失败」；ledger 含「1 个失败」且无「安装中」；磁盘 a/b=0.0.2、c=0.0.1；无全批假成功',
    actual: JSON.stringify({ failedBanner, rows: failurePanel !== null ? failurePanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur, next: row.versionNew, status: row.status, fail: row.fail, actions: row.actions })) : null, summary: failureSummary, ledger: failureLedger, disk: failureDisk, ledgerC: ledgerPartial !== null ? { state: ledgerStateOf(ledgerPartial), target: ledgerPartial.state['targetVersion'] } : null }),
    verdict: rowsNoRunning && badRowOk && badRowRetryOk && bannerOk && partialSummaryOk && partialLedgerOk && noFakeSuccess && goodRowsOk && badLedgerPartialOk ? 'pass' : 'fail',
  })
  rec({ step: 'k3-07-no-full-fake-success', what: '部分失败后总账/台账不出现「全批成功」', expected: 'summary 不含「已全部为最新」；ledger 不含「3 个已是最新」', actual: 'summary=' + JSON.stringify(failureSummary) + '；ledger=' + JSON.stringify(failureLedger), ok: noFakeSuccess })
  rec({ step: 'k3-08-failed-banner', what: '失败横幅：标题/名单/动作提示', expected: '标题「1 个插件安装失败。」；名单恰 1 条含夹具 C；动作含复制诊断/复制手工命令', actual: JSON.stringify(failedBanner), ok: bannerOk })
  rec({ step: 'k3-09-failed-row', what: 'C 行失败态 truthful（最后手段 + 可重试，不谎称安装中/成功）', expected: 'phase=failed；status 含「最后手段」「安装失败，请选择「重试」」；fail 含 install-failed；actions 含 row-install', actual: JSON.stringify(rowC), ok: badRowOk && badRowRetryOk && rowsNoRunning })
  rec({ step: 'k3-10-summary-ledger-partial', what: '总账/台账逐行计数与失败横幅一致', expected: 'summary 含「1 个插件安装失败」且无「安装中」；ledger 含「1 个失败」且无「安装中」', actual: 'summary=' + JSON.stringify(failureSummary) + '；ledger=' + JSON.stringify(failureLedger), ok: partialSummaryOk && partialLedgerOk })
  rec({ step: 'k3-11-good-rows-unaffected', what: '好行不受坏行影响（A/B 磁盘与台账都到目标版）', expected: 'a/b 磁盘=0.0.2；A/B 台账成功终态 target=0.0.2', actual: JSON.stringify({ disk: failureDisk, ledgerA: ledgerStateOf(ledgerAPartial), ledgerB: ledgerStateOf(ledgerBPartial) }), ok: goodRowsOk })
  rec({ step: 'k3-12-bad-ledger-failed', what: '坏行台账真相：failed + 目标版本 0.0.2', expected: 'state=failed、targetVersion=0.0.2', actual: JSON.stringify(ledgerPartial !== null ? { state: ledgerStateOf(ledgerPartial), target: ledgerPartial.state['targetVersion'] } : null), ok: badLedgerPartialOk })

  // ---- 5. 停第一代宿主读后端事实：A/B 各一次成功、C 一次执行失败（安装阶段） ----
  await sleep(500)
  await stopHostGen(ctx, gen1, 'k3-after-partial')
  const events1 = await readEvents(ctx)
  const execs1A = installExecsOf(events1, packageA)
  const execs1B = installExecsOf(events1, packageB)
  const execs1C = installExecsOf(events1, packageC)
  const fails1C = installFailsOf(events1, packageC)
  const stageExecFails1C = fails1C.filter((event) => event.fields['stage'] === 'exec')
  const gateFails1 = installFailsOf(events1, packageB).concat(fails1C).filter((event) => event.fields['stage'] === 'gate')
  const audit1 = auditInstallFails(asAuditFacts(events1))
  await ctx.run.raw('k3-gen1-backend', { execsA: execs1A, execsB: execs1B, execsC: execs1C, failsC: fails1C, gateFails: gateFails1, audit: audit1 })
  const execs1Ok = execs1A.length === 1 && okExecCount(execs1A) === 1 && execs1B.length === 1 && okExecCount(execs1B) === 1 && execs1C.length === 1 && okExecCount(execs1C) === 0
  rec({ step: 'k3-13-exec-generated', what: '第一代宿主：A/B 各恰一次成功执行，C 恰一次失败执行（坏 tarball 只在执行阶段失败）', expected: 'A/B exec=1 且 ok=1；C exec=1 且 ok=0；stage=exec 的 install.fail 恰 1 条 code=install-failed', actual: 'execA=' + String(execs1A.length) + ' okA=' + String(okExecCount(execs1A)) + ' execB=' + String(execs1B.length) + ' okB=' + String(okExecCount(execs1B)) + ' execC=' + String(execs1C.length) + ' okC=' + String(okExecCount(execs1C)) + ' stageExecFails=' + JSON.stringify(stageExecFails1C.map((event) => ({ code: event.fields['code'], reason: event.fields['reason'], exitCode: event.fields['exitCode'] }))), ok: execs1Ok && stageExecFails1C.length === 1 && stageExecFails1C[0] !== undefined && stageExecFails1C[0].fields['code'] === 'install-failed' })
  rec({ step: 'k3-14-gate-retry-fact', what: '记录产品 gate 重试事实（A 自更新成功会触发宿主重载，后续行的 gate 可能 check-expired 一次后重试成功；不算安装失败）', expected: 'stage=gate 的失败都是 check-expired；安装执行失败只算 C 的那 1 条', actual: JSON.stringify(gateFails1.map((event) => ({ stage: event.fields['stage'], code: event.fields['code'], reason: event.fields['reason'] }))), ok: gateFails1.every((event) => event.fields['code'] === 'check-expired') && audit1.nonCheckExpired === 1 })

  // ---- 6. 恢复环境：tarball 复原 + 清掉坏 tarball 在 run 私有 pnpm store 的失败缓存 ----
  const restore = await restoreCorruptedTarball({ registry: fixtureEnv.registry, fault: corruption })
  await ctx.run.raw('k3-restore-tarball', restore)
  rec({ step: 'k3-15-tarball-restored', what: '还原 C 的 tarball 字节（恢复后 sha 与原始一致、元数据未动）', expected: 'shaMatches=true、versionDocUnchanged=true', actual: JSON.stringify(restore), ok: restore.shaMatches === true && restore.versionDocUnchanged === true })
  // K2 已证明：坏 tarball 的失败尝试会在 run 私有 pnpm store 留下 integrity 不匹配的缓存，restore 后旧 store 仍会反复重试。
  // 这里只清 pnpm 缓存（不动已装 node_modules、不改产品代码），让第二代宿主的 pnpm 重新拉取；这是修环境不是修产品。
  const storeDir = join(ctx.run.layout.root, 'pnpm-store')
  const storeFilesBefore = (await listFilesRecursive(storeDir).catch(() => [] as string[])).length
  await rm(storeDir, { recursive: true, force: true })
  await ensureDir(storeDir)
  await ctx.run.raw('k3-pnpm-store-reset', { storeDir, filesBefore: storeFilesBefore })
  rec({ step: 'k3-16-store-reset', what: '清空 run 私有 pnpm store 的坏 tarball 失败缓存（环境修复，只清缓存不动已装包）', expected: 'reset 前 store 有文件，reset 后目录存在', actual: 'filesBefore=' + String(storeFilesBefore), ok: storeFilesBefore > 0 })

  // ---- 7. 第二代宿主：未完成批次续跑（默认 autoResume + 中枢接管；若被冻结则真 UI 点续跑/重试） ----
  const gen2 = await startHostGen(ctx, 'k3-gen2')
  const ui2 = uiOf(gen2)
  const live2 = (): DesktopSession => webSessionOf(ui2.page)
  await waitForBatchSeat(live2(), 'a', (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3, { label: 'gen2 批量面板三行挂载', timeoutMs: 180000, intervalMs: 300 })
  const restartSnap = await readBatchSeat(live2(), 'a').catch(() => null)
  const restartExtras = await readBatchExtras(ui2, cardA).catch(() => null)
  const restartDisk = await diskVersions(ctx, [packageC])
  const restartRowC = restartSnap !== null ? rowOfSeat(restartSnap, 'c') : null
  const restartTruthful = restartDisk[packageC] === FIXTURE_VARIANT_VERSION ? true : (restartRowC === null || (restartRowC.phase !== 'done' && restartRowC.phase !== 'current'))
  await ctx.run.raw('k3-restart-before-resume', { rowC: restartRowC, summary: restartSnap !== null ? restartSnap.panel.summary : null, ledger: restartSnap !== null ? restartSnap.panel.ledger : null, more: restartExtras !== null ? restartExtras.more : null, notice: restartExtras !== null ? restartExtras.notice : null, disk: restartDisk })
  rec({ step: 'k3-17-restart-truth', what: '重启后首帧：C 磁盘仍旧版时 UI 不得把 C 行标成 done/current（另有未完成续跑路径）', expected: 'disk c=0.0.1 时 C 行 phase 不为 done/current', actual: JSON.stringify({ diskC: restartDisk[packageC], rowC: restartRowC, more: restartExtras !== null ? restartExtras.more : null, notice: restartExtras !== null ? restartExtras.notice : null }), ok: restartTruthful })

  let diskNow = await diskVersions(ctx, [packageC])
  let resumePath = 'auto'
  const autoDeadline = Date.now() + 90000
  while (Date.now() < autoDeadline && diskNow[packageC] !== FIXTURE_VARIANT_VERSION) {
    await sleep(500)
    diskNow = await diskVersions(ctx, [packageC])
  }
  if (diskNow[packageC] !== FIXTURE_VARIANT_VERSION) {
    const midSeat = await readBatchSeat(live2(), 'a').catch(() => null)
    const midRowC = midSeat !== null ? rowOfSeat(midSeat, 'c') : null
    const busy = midRowC !== null && (midRowC.phase === 'installing' || midRowC.queued === true)
    if (!busy) {
      resumePath = 'manual'
      const midExtras = await readBatchExtras(ui2, cardA).catch(() => null)
      await ctx.run.raw('k3-manual-resume-offer', { more: midExtras !== null ? midExtras.more : null, rowC: midRowC })
      const canResume = midExtras !== null && midExtras.more !== null
      if (canResume) {
        await clickSeatAction(live2(), 'a', 'resume')
      } else {
        await clickSeatAction(live2(), 'a', 'row-install', 'c')
      }
    }
    const manualDeadline = Date.now() + 240000
    while (Date.now() < manualDeadline && diskNow[packageC] !== FIXTURE_VARIANT_VERSION) {
      await sleep(500)
      diskNow = await diskVersions(ctx, [packageC])
    }
  }
  await ctx.run.raw('k3-resume-path', { path: resumePath, diskC: diskNow[packageC] })
  if (diskNow[packageC] !== FIXTURE_VARIANT_VERSION) throw new Error('K3 重启后续跑/重试后 C 仍未装到 0.0.2（disk=' + String(diskNow[packageC]) + '）')
  rec({ step: 'k3-18-resume-effect', what: '未完成批次在第二代宿主里被继续（默认自动续跑；冻结时真 UI 点续跑/行内重试）', expected: 'C 磁盘到 0.0.2', actual: 'path=' + resumePath + '；diskC=' + String(diskNow[packageC]), ok: diskNow[packageC] === FIXTURE_VARIANT_VERSION })

  await waitForBatchSeat(live2(), 'a', (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => (row.phase === 'done' || row.phase === 'current') && row.versionCur === FIXTURE_VARIANT_VERSION), { label: '续跑后三行 done/current 0.0.2', timeoutMs: 180000, intervalMs: 500 })
  const ledgerCAfter = await waitForLedger(ctx, packageC, SUCCESS_STATES as readonly string[], 'K3 续跑后 C 台账成功终态', 120000)
  const ledgerAAfter = await ledgerFor(ctx, packageA)
  const ledgerBAfter = await ledgerFor(ctx, packageB)
  await sleep(1000)
  const resumedPanel = await readBatchSeat(live2(), 'a')
  const resumedExtras = await readBatchExtras(ui2, cardA).catch(() => null)
  const resumedDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const resumedSummary = resumedPanel.panel.summary || ''
  const resumedLedger = resumedPanel.panel.ledger || ''
  const resumedRowsOk = resumedPanel.panel.rows.length === 3 && resumedPanel.panel.rows.every((row) => (row.phase === 'done' || row.phase === 'current') && row.versionCur === FIXTURE_VARIANT_VERSION)
  const resumedSummaryOk = resumedSummary.indexOf('已全部为最新') >= 0 || resumedSummary.indexOf('个已安装完成') >= 0
  const resumedLedgerOk = resumedLedger.indexOf('3 个已是最新') >= 0 || resumedLedger.indexOf('3 个待重启') >= 0
  const resumedLedgerCok = isSuccessLedger(ledgerCAfter) && ledgerCAfter !== null && ledgerCAfter.state['targetVersion'] === FIXTURE_VARIANT_VERSION
  const goodRowsStayOk = isSuccessLedger(ledgerAAfter) && isSuccessLedger(ledgerBAfter) && ledgerAAfter !== null && ledgerBAfter !== null && ledgerAAfter.state['targetVersion'] === FIXTURE_VARIANT_VERSION && ledgerBAfter.state['targetVersion'] === FIXTURE_VARIANT_VERSION
  await capture(ctx.run, ui2, {
    step: 'k3-50-after-resume',
    what: '续跑完成：C 行转 done/current，失败横幅消失，三行 0.0.2；总账/台账与磁盘一致',
    expected: '三行 done/current 0.0.2；summary 含「已全部为最新」或「个已安装完成」；ledger 含「3 个已是最新」或「3 个待重启」；磁盘三包 0.0.2；C 台账成功终态；notice 含「已继续上次未完成的更新」',
    actual: JSON.stringify({ rows: resumedPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })), summary: resumedSummary, ledger: resumedLedger, disk: resumedDisk, ledgerC: { state: ledgerStateOf(ledgerCAfter), target: ledgerCAfter !== null ? ledgerCAfter.state['targetVersion'] : null }, notice: resumedExtras !== null ? resumedExtras.notice : null, failed: resumedExtras !== null ? resumedExtras.failed : null }),
    verdict: resumedRowsOk && resumedSummaryOk && resumedLedgerOk && resumedLedgerCok && goodRowsStayOk ? 'pass' : 'fail',
  })
  rec({ step: 'k3-19-resume-rows', what: '续跑后三行 done/current 0.0.2、失败横幅消失', expected: '三行 done/current、versionCur=0.0.2；failed=null', actual: JSON.stringify(resumedPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur }))), ok: resumedRowsOk && resumedExtras !== null && resumedExtras.failed === null })
  rec({ step: 'k3-20-resume-summary', what: '续跑后总账/台账转完成', expected: 'summary 含「已全部为最新」或「个已安装完成」；ledger 含「3 个已是最新」或「3 个待重启」', actual: 'summary=' + JSON.stringify(resumedSummary) + '；ledger=' + JSON.stringify(resumedLedger), ok: resumedSummaryOk && resumedLedgerOk })
  rec({ step: 'k3-21-resume-bad-ledger', what: 'C 台账续跑成功终态（目标 0.0.2）', expected: 'state∈{completed,restart-required}、targetVersion=0.0.2', actual: JSON.stringify(ledgerCAfter !== null ? { state: ledgerStateOf(ledgerCAfter), target: ledgerCAfter.state['targetVersion'] } : null), ok: resumedLedgerCok })
  rec({ step: 'k3-22-good-rows-not-reinstalled', what: '好行不被续跑重复安装（A/B 台账仍是成功终态）', expected: 'A/B 台账成功终态 target=0.0.2', actual: JSON.stringify({ a: ledgerStateOf(ledgerAAfter), b: ledgerStateOf(ledgerBAfter) }), ok: goodRowsStayOk })

  // ---- 8. 停第二代宿主：exactly-once（A/B 各一次成功，C 一次失败 + 一次成功）、台账逐行真相 ----
  await sleep(800)
  await stopHostGen(ctx, gen2, 'k3-after-resume')
  const events2 = await readEvents(ctx)
  const execsA = installExecsOf(events2, packageA)
  const execsB = installExecsOf(events2, packageB)
  const execsC = installExecsOf(events2, packageC)
  const failsC = installFailsOf(events2, packageC)
  const stageExecFailsC = failsC.filter((event) => event.fields['stage'] === 'exec')
  const audit = auditInstallFails(asAuditFacts(events2))
  const jobsA = await ledgerJobsOf(ctx, packageA)
  const jobsB = await ledgerJobsOf(ctx, packageB)
  const jobsC = await ledgerJobsOf(ctx, packageC)
  await ctx.run.raw('k3-final-backend', { execsA, execsB, execsC, failsC, audit, jobs: { a: jobsA.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'], mtimeMs: entry.mtimeMs })), b: jobsB.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], mtimeMs: entry.mtimeMs })), c: jobsC.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], mtimeMs: entry.mtimeMs })) } })
  const exactlyOnceOk = execsA.length === 1 && okExecCount(execsA) === 1 && execsB.length === 1 && okExecCount(execsB) === 1 && execsC.length === 2 && okExecCount(execsC) === 1 && stageExecFailsC.length === 1
  rec({ step: 'k3-23-exactly-once', what: '续跑/重试语义：A/B 不重复安装、C 恰一次失败 + 恰一次成功', expected: 'A/B exec=1 且 ok=1；C exec=2（1 失败 1 成功）；stage=exec 的 install.fail 恰 1 且 code=install-failed', actual: 'execA=' + String(execsA.length) + ' okA=' + String(okExecCount(execsA)) + ' execB=' + String(execsB.length) + ' okB=' + String(okExecCount(execsB)) + ' execC=' + String(execsC.length) + ' okC=' + String(okExecCount(execsC)) + ' stageExecFails=' + JSON.stringify(stageExecFailsC.map((event) => ({ code: event.fields['code'], reason: event.fields['reason'] }))), ok: exactlyOnceOk })
  // 台账布局（src/core/disk.ts:60-65）：状态目录 = updates/<插件标识>/<profile 目录短指纹>，同一插件同一 profile 只有一份 state.json；
  // 重试/续跑覆盖同一条记录、不追加历史行。所以「不重复/不丢行」= 每包恰一条记录且终态成功；C 的失败历史由 k3-23 的日志 exec/fail 计数承载。
  const ledgerRows = [jobsA, jobsB, jobsC]
  const jobsOk = ledgerRows.every((jobs) => jobs.length === 1) && ledgerRows.every((jobs) => isSuccessLedger(jobs[0] as LedgerEntry) && jobs[0].state['targetVersion'] === FIXTURE_VARIANT_VERSION && jobs[0].state['previousVersion'] === FIXTURE_BASE_VERSION)
  rec({ step: 'k3-24-ledger-rows', what: '台账逐行真相：每包恰一条记录（同一 profile 只有一份 state.json，重试覆盖不追加），三包终态成功；C 的失败历史由日志计数承载', expected: 'A/B/C 各 1 条 state.json；state∈{completed,restart-required}；targetVersion=0.0.2；previousVersion=0.0.1', actual: JSON.stringify({ a: jobsA.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })), b: jobsB.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })), c: jobsC.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })) }), ok: jobsOk })
  rec({ step: 'k3-25-fail-audit', what: '失败审计：唯一真失败是坏 tarball 在 C 上的执行失败（无其它未归因失败）', expected: 'nonCheckExpired=1', actual: JSON.stringify(audit), ok: audit.nonCheckExpired === 1 })

  // ---- 9. 第三代宿主重启：三行 current 0.0.2、总账/台账/卡片标记一致 ----
  const gen3 = await startHostGen(ctx, 'k3-gen3')
  const ui3 = uiOf(gen3)
  await waitForBatchSeat(webSessionOf(ui3.page), 'a', (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3, { label: 'gen3 批量面板三行挂载', timeoutMs: 180000, intervalMs: 500 })
  await waitForBatchSeat(webSessionOf(ui3.page), 'a', (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === FIXTURE_VARIANT_VERSION), { label: '重启后批量面板三行 current 0.0.2', timeoutMs: 180000, intervalMs: 500 })
  await sleep(1500)
  const finalPanel = await readBatchSeat(webSessionOf(ui3.page), 'a')
  const tagsAfterA = await readCardTags(ui3, cardA)
  const tagsAfterB = await readCardTags(ui3, cardSelectorOf('b')).catch(() => null)
  const tagsAfterC = await readCardTags(ui3, cardSelectorOf('c')).catch(() => null)
  const finalDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const ledgerFinalA = await waitForLedger(ctx, packageA, ['completed'], 'K3 重启后 A 台账 completed', 90000)
  const ledgerFinalB = await waitForLedger(ctx, packageB, ['completed'], 'K3 重启后 B 台账 completed', 90000)
  const ledgerFinalC = await waitForLedger(ctx, packageC, ['completed'], 'K3 重启后 C 台账 completed', 90000)
  const restartRowsOk = finalPanel.panel.rows.length === 3 && finalPanel.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === FIXTURE_VARIANT_VERSION)
  const tagsOk = tagsAfterA.clientTag === tagsA.clientTag && tagsAfterA.hostTag === tagsA.hostTag && tagsAfterB !== null && tagsAfterB.clientTag === tagsB.clientTag && tagsAfterB.hostTag === tagsB.hostTag && tagsAfterC !== null && tagsAfterC.clientTag === tagsC.clientTag
  const restartLedgerOk = ledgerStateOf(ledgerFinalA) === 'completed' && ledgerStateOf(ledgerFinalB) === 'completed' && ledgerStateOf(ledgerFinalC) === 'completed'
  await capture(ctx.run, ui3, {
    step: 'k3-60-after-restart',
    what: '重启后：批量面板三行 current 0.0.2、总账「已全部为最新」、卡片构建标记 v0.0.2、台账三条 completed',
    expected: '三行 current 0.0.2；summary 含「已全部为最新」；ledger 含「3 个已是最新」；A/B clientTag/hostTag=v0.0.2、C clientTag=v0.0.2；台账三包 completed',
    actual: JSON.stringify({ rows: finalPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })), summary: finalPanel.panel.summary, ledger: finalPanel.panel.ledger, tagsA: tagsAfterA, tagsB: tagsAfterB, tagsC: tagsAfterC, disk: finalDisk, ledgerStates: { a: ledgerStateOf(ledgerFinalA), b: ledgerStateOf(ledgerFinalB), c: ledgerStateOf(ledgerFinalC) } }),
    verdict: restartRowsOk && tagsOk && restartLedgerOk && finalDisk[packageA] === FIXTURE_VARIANT_VERSION && finalDisk[packageB] === FIXTURE_VARIANT_VERSION && finalDisk[packageC] === FIXTURE_VARIANT_VERSION ? 'pass' : 'fail',
  })
  rec({ step: 'k3-26-restart-rows', what: '重启后批量行相位与版本（UI 与磁盘一致）', expected: '三行 current/done、versionCur=0.0.2', actual: JSON.stringify(finalPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur }))), ok: restartRowsOk })
  rec({ step: 'k3-27-restart-summary', what: '重启后总账/台账', expected: 'summary 含「已全部为最新」；ledger 含「3 个已是最新」', actual: JSON.stringify({ summary: finalPanel.panel.summary, ledger: finalPanel.panel.ledger }), ok: (finalPanel.panel.summary || '').indexOf('已全部为最新') >= 0 && (finalPanel.panel.ledger || '').indexOf('3 个已是最新') >= 0 })
  rec({ step: 'k3-28-build-tags', what: '三包运行内容都是 0.0.2 构建（不是版本号假成功）', expected: 'A/B clientTag/hostTag 与 C clientTag 都等于 0.0.2 变体标记', actual: JSON.stringify({ tagsA: tagsAfterA, tagsB: tagsAfterB, tagsC: tagsAfterC, expected: { a: tagsA, b: tagsB, c: tagsC } }), ok: tagsOk })
  rec({ step: 'k3-29-restart-ledger', what: '重启后台账三包各一条 completed（不重复/不丢）', expected: '三包 state=completed、targetVersion=0.0.2', actual: JSON.stringify({ a: ledgerStateOf(ledgerFinalA), b: ledgerStateOf(ledgerFinalB), c: ledgerStateOf(ledgerFinalC) }), ok: restartLedgerOk })
  rec({ step: 'k3-30-final-disk', what: '重启后磁盘三包仍 0.0.2（UI/台账/磁盘三处一致）', expected: '三包 versions=0.0.2', actual: JSON.stringify(finalDisk), ok: finalDisk[packageA] === FIXTURE_VARIANT_VERSION && finalDisk[packageB] === FIXTURE_VARIANT_VERSION && finalDisk[packageC] === FIXTURE_VARIANT_VERSION })
}

/** K4：批量部分失败隔离 → 杀宿主 → 重启续跑入口（双闸冻结）→ 手动续跑 → exactly-once → 重启一致。 */
async function runK4(ctx: KContext, options: KUiScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const fixtureEnv = ctx.run.fixtureEnv
  if (!fixtureEnv) throw new Error('K4 需要夹具环境')
  const packageA = FIXTURE_SLOT_A.packageName
  const packageB = FIXTURE_SLOT_B.packageName
  const packageC = FIXTURE_SLOT_C.packageName
  const cardA = cardSelectorOf('a')
  const tagsA = fixtureBuildTagsOf(FIXTURE_SLOT_A, FIXTURE_VARIANT_VERSION)
  const tagsB = fixtureBuildTagsOf(FIXTURE_SLOT_B, FIXTURE_VARIANT_VERSION)
  const tagsC = fixtureBuildTagsOf(FIXTURE_SLOT_C, FIXTURE_VARIANT_VERSION)
  const terminalPhase = (phase: string | null): boolean => phase === 'current' || phase === 'done'
  const settledPhase = (phase: string | null): boolean => terminalPhase(phase) || phase === 'failed' || phase === 'skipped'
  const tarballRequestCount = (): number => ctx.front.requests().filter((item) => item.url.indexOf('/-/') >= 0 && /\.tgz(\?|$)/.test(item.url)).length
  /** 台账记录的紧凑快照（证明续跑不改写已完成行）。 */
  const ledgerBriefOf = (entry: LedgerEntry | null): { file: string; mtimeMs: number; id: unknown; state: string; targetVersion: unknown } | null =>
    entry === null ? null : { file: entry.file, mtimeMs: entry.mtimeMs, id: entry.state['id'], state: ledgerStateOf(entry), targetVersion: entry.state['targetVersion'] }

  // ---- 1. gen1：三包查成 ready → 注入坏 C tarball → 真 UI「全部更新」→ 部分失败隔离 ----
  const gen1 = await startHostGen(ctx, 'k4-gen1', { delayMs: 3000, match: 'pnpm-user-agent' })
  const ui1 = uiOf(gen1)
  const live1 = (): DesktopSession => webSessionOf(ui1.page)
  await waitForBatchSeat(live1(), 'a', (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3, { label: 'K4 gen1 批量面板三行挂载', timeoutMs: 180000, intervalMs: 300 })
  await waitForBatchSeat(live1(), 'a', (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => row.versionNew === FIXTURE_VARIANT_VERSION) && state.panel.install !== null && state.panel.install.disabled === false, { label: 'K4 三行检查成可更新且「全部更新」可点', timeoutMs: 180000, intervalMs: 300 })
  const corruption = await corruptPublishedTarball({ registry: fixtureEnv.registry, backupDir: join(ctx.run.layout.rawDir, 'k4-corrupt-c'), packageName: packageC, version: FIXTURE_VARIANT_VERSION })
  await ctx.run.raw('k4-registry-tarball-corrupted', corruption)
  rec({ step: 'k4-01-fault-injection', what: '改坏 C 的 tarball 字节（元数据/integrity 不动 ⇒ check 能过、install 必失败）', expected: 'servedBefore/After=200；sha256 变了；versionDocUnchanged=true', actual: JSON.stringify({ servedBefore: corruption.servedBeforeStatus, servedAfter: corruption.servedAfterStatus, sizeBytes: corruption.sizeBytes, sha256Before: corruption.sha256Before, sha256After: corruption.sha256After, versionDocUnchanged: corruption.versionDocUnchanged }), ok: corruption.servedBeforeStatus === 200 && corruption.servedAfterStatus === 200 && corruption.sha256Before !== corruption.sha256After && corruption.versionDocUnchanged })

  await clickSeatAction(live1(), 'a', 'install')
  // 安装窗只轮询磁盘 + 台账（CDP 会随宿主 relaunch 失效，不在安装窗读 DOM）。
  const partialDeadline = Date.now() + INSTALL_TIMEOUT_MS
  let partialDisk: Record<string, string | null> = {}
  let partialLedgerC: LedgerEntry | null = null
  let partialSettled = false
  while (Date.now() < partialDeadline) {
    partialDisk = await diskVersions(ctx, [packageA, packageB, packageC])
    partialLedgerC = await ledgerFor(ctx, packageC)
    if (partialDisk[packageA] === FIXTURE_VARIANT_VERSION && partialDisk[packageB] === FIXTURE_VARIANT_VERSION && ledgerStateOf(partialLedgerC) === 'failed') { partialSettled = true; break }
    await sleep(1000)
  }
  if (!partialSettled) throw new Error('K4 部分失败未在时限内落定（disk=' + JSON.stringify(partialDisk) + '，ledgerC=' + ledgerStateOf(partialLedgerC) + '）')
  const failureSeat = await waitForBatchSeat(live1(), 'a', (state) => {
    const rowC = state.panel.rows.find((row) => row.key === 'c') || null
    return state.panel.rows.length >= 3 && state.panel.rows.every((row) => row.phase !== 'installing' && row.queued !== true) && rowC !== null && rowC.phase === 'failed'
  }, { label: 'K4 部分失败后面板重排（C 行 failed、无安装中行）', timeoutMs: 180000, intervalMs: 500 }).catch(() => null)
  await sleep(1200)
  const failurePanel = failureSeat !== null ? failureSeat : await readBatchSeat(live1(), 'a').catch(() => null)
  const failureExtras = await readBatchExtras(ui1, cardA).catch(() => null)
  const partialLedgerA = await waitForLedger(ctx, packageA, SUCCESS_STATES as readonly string[], 'K4 A 台账成功（部分失败现场）', 90000)
  const partialLedgerB = await waitForLedger(ctx, packageB, SUCCESS_STATES as readonly string[], 'K4 B 台账成功（部分失败现场）', 90000)
  const failureDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const failureSummary = failurePanel !== null ? (failurePanel.panel.summary || '') : ''
  const failureLedger = failurePanel !== null ? (failurePanel.panel.ledger || '') : ''
  const failedBanner = failureExtras !== null ? failureExtras.failed : null
  const rowCFailure = failurePanel !== null ? rowOfSeat(failurePanel, 'c') : null
  const isolatedOk = failureDisk[packageA] === FIXTURE_VARIANT_VERSION && failureDisk[packageB] === FIXTURE_VARIANT_VERSION && failureDisk[packageC] === FIXTURE_BASE_VERSION && isSuccessLedger(partialLedgerA) && isSuccessLedger(partialLedgerB) && ledgerStateOf(partialLedgerC) === 'failed' && partialLedgerC !== null && partialLedgerC.state['targetVersion'] === FIXTURE_VARIANT_VERSION
  const noFakeSuccessOk = failureSummary.indexOf('已全部为最新') < 0 && failureLedger.indexOf('3 个已是最新') < 0 && failureSummary.indexOf('1 个插件安装失败') >= 0
  const failureRowOk = rowCFailure !== null && rowCFailure.phase === 'failed' && (rowCFailure.status || '').indexOf('最后手段') >= 0
  await capture(ctx.run, ui1, {
    step: 'k4-10-partial-failure',
    what: '批量部分失败隔离（杀宿主前的现场）：C 坏 tarball 失败、A/B 已完成；总账/台账不谎称全批成功',
    expected: '磁盘 a/b=0.0.2、c=0.0.1；C 台账 failed target=0.0.2；A/B 台账成功终态；summary 含「1 个插件安装失败」且无「已全部为最新」；C 行 failed（最后手段）',
    actual: JSON.stringify({ disk: failureDisk, summary: failureSummary, ledger: failureLedger, banner: failedBanner, rowC: rowCFailure === null ? null : { phase: rowCFailure.phase, status: rowCFailure.status, fail: rowCFailure.fail }, ledgerC: { state: ledgerStateOf(partialLedgerC), target: partialLedgerC !== null ? partialLedgerC.state['targetVersion'] : null } }),
    verdict: isolatedOk && noFakeSuccessOk && failureRowOk ? 'pass' : 'fail',
  })
  rec({ step: 'k4-02-partial-isolated', what: '部分失败隔离：坏行失败、好行完成、无全批假成功', expected: 'a/b 磁盘 0.0.2 且台账成功；c 磁盘 0.0.1 且台账 failed target=0.0.2；summary 含「1 个插件安装失败」、不含「已全部为最新」', actual: JSON.stringify({ disk: failureDisk, ledgerA: ledgerStateOf(partialLedgerA), ledgerB: ledgerStateOf(partialLedgerB), ledgerC: ledgerStateOf(partialLedgerC), summary: failureSummary, ledger: failureLedger }), ok: isolatedOk && noFakeSuccessOk && failureRowOk })

  // ---- 2. 杀宿主（taskkill 整树）：此刻三行终态、无在飞安装，安装锁已释放 ----
  const aBeforeKill = ledgerBriefOf(await ledgerFor(ctx, packageA))
  const bBeforeKill = ledgerBriefOf(await ledgerFor(ctx, packageB))
  const cBeforeKill = ledgerBriefOf(await ledgerFor(ctx, packageC))
  await ctx.run.raw('k4-before-kill', { disk: failureDisk, ledger: { a: aBeforeKill, b: bBeforeKill, c: cBeforeKill }, summary: failureSummary, ledgerLine: failureLedger })
  await sleep(500)
  await stopHostGen(ctx, gen1, 'k4-kill-after-partial')
  const killDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const killBatch = await diskBatchEntries(ctx)
  const killLedgerC = await ledgerFor(ctx, packageC)
  const killTruthOk = killDisk[packageA] === FIXTURE_VARIANT_VERSION && killDisk[packageB] === FIXTURE_VARIANT_VERSION && killDisk[packageC] === FIXTURE_BASE_VERSION && ledgerStateOf(killLedgerC) === 'failed' && killBatch.length === 3 && killBatch.every((entry) => settledPhase(entry.phase))
  await ctx.run.raw('k4-after-kill', { disk: killDisk, batch: killBatch, ledgerC: { state: ledgerStateOf(killLedgerC), target: killLedgerC !== null ? killLedgerC.state['targetVersion'] : null } })
  rec({ step: 'k4-03-kill-truth', what: '杀宿主后的落盘真相：A/B 已装 0.0.2、C 仍 0.0.1、C 台账 failed、批量会话三行全终态（无在飞安装）', expected: 'a/b 磁盘 0.0.2；c 磁盘 0.0.1；C 台账 failed；会话三行 phase∈{current,done,failed,skipped}', actual: JSON.stringify({ disk: killDisk, batch: killBatch.map((entry) => ({ key: entry.key, phase: entry.phase, target: entry.targetVersion })), ledgerC: ledgerStateOf(killLedgerC) }), ok: killTruthOk })

  // ---- 3. 环境修复：复原 C tarball + 清 run 私有 pnpm store 的坏 tarball 缓存（不动产品/已装包） ----
  const restore = await restoreCorruptedTarball({ registry: fixtureEnv.registry, fault: corruption })
  await ctx.run.raw('k4-restore-tarball', restore)
  rec({ step: 'k4-04-tarball-restored', what: '还原 C 的 tarball 字节（sha 复原、元数据未动）', expected: 'shaMatches=true、versionDocUnchanged=true', actual: JSON.stringify(restore), ok: restore.shaMatches === true && restore.versionDocUnchanged === true })
  const storeDir = join(ctx.run.layout.root, 'pnpm-store')
  const storeFilesBefore = (await listFilesRecursive(storeDir).catch(() => [] as string[])).length
  await rm(storeDir, { recursive: true, force: true })
  await ensureDir(storeDir)
  await ctx.run.raw('k4-pnpm-store-reset', { storeDir, filesBefore: storeFilesBefore })
  rec({ step: 'k4-05-store-reset', what: '清空 run 私有 pnpm store 的坏 tarball 失败缓存（续跑要重新拉取好 tarball；环境修复）', expected: 'reset 前 store 有文件', actual: 'filesBefore=' + String(storeFilesBefore), ok: storeFilesBefore > 0 })

  // ---- 4. gen2：A@0.0.2 双闸（autoResume:false + hub:false）→ 自动检查对账 C 的 failed→ready → 续跑入口 ----
  const gen2 = await startHostGen(ctx, 'k4-gen2')
  const ui2 = uiOf(gen2)
  const live2 = (): DesktopSession => webSessionOf(ui2.page)
  await waitForBatchSeat(live2(), 'a', (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3, { label: 'K4 gen2 批量面板三行挂载', timeoutMs: 180000, intervalMs: 300 })
  const restartSeat = await readBatchSeat(live2(), 'a').catch(() => null)
  const restartExtras = await readBatchExtras(ui2, cardA).catch(() => null)
  const restartDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const restartRowC = restartSeat !== null ? rowOfSeat(restartSeat, 'c') : null
  const restartTruthful = restartDisk[packageC] === FIXTURE_VARIANT_VERSION || restartRowC === null || (restartRowC.phase !== 'done' && restartRowC.phase !== 'current')
  await ctx.run.raw('k4-restart-first-frame', { disk: restartDisk, rowC: restartRowC, more: restartExtras !== null ? restartExtras.more : null, summary: restartSeat !== null ? restartSeat.panel.summary : null })
  rec({ step: 'k4-06-restart-truth', what: '重启首帧：C 的磁盘仍是 0.0.1 时 UI 不把 C 行标成 done/current（真实未完成）', expected: 'diskC=0.0.1 时 C 行 phase 不为 done/current', actual: JSON.stringify({ diskC: restartDisk[packageC], rowC: restartRowC }), ok: restartTruthful })
  // 面板自动检查会把失败行按检查事实对账成 ready（#152 成功检查对账），从而出现续跑入口。
  const offer = await waitForBatchExtras(ui2, cardA, (extras) => !!extras.more && /^继续上次未完成的更新（剩余 \d+ 个）。$/.test(extras.more.resume), 'K4 续跑入口出现（自动检查对账后）', 180000)
  const moreOffer = offer.more
  if (!moreOffer) throw new Error('K4 续跑区缺失（more=null）')
  const offerTextsOk = moreOffer.resumeTitle === '从上次中断处继续安装，已完成的不会重复安装。' && moreOffer.cancel === '丢弃本批未完成的更新（已完成的将保留）。' && moreOffer.cancelConfirm === ''
  const offerSeat = await readBatchSeat(live2(), 'a')
  const offerRowA = rowOfSeat(offerSeat, 'a')
  const offerRowB = rowOfSeat(offerSeat, 'b')
  const offerRowC = rowOfSeat(offerSeat, 'c')
  const offerRowsOk = offerRowA !== null && offerRowB !== null && offerRowC !== null && terminalPhase(offerRowA.phase) && terminalPhase(offerRowB.phase) && offerRowA.versionCur === FIXTURE_VARIANT_VERSION && offerRowB.versionCur === FIXTURE_VARIANT_VERSION && offerRowC.phase === 'ready' && offerRowC.versionNew === FIXTURE_VARIANT_VERSION
  await capture(ctx.run, ui2, {
    step: 'k4-20-resume-offer',
    what: '重启后续跑入口：A/B 已完成（0.0.2），C 的失败行被自动检查对账成 ready，「继续上次未完成的更新」按钮出现；双闸下没有自动续跑',
    expected: 'resume 文案「继续上次未完成的更新（剩余 n 个）。」、title「从上次中断处继续安装，已完成的不会重复安装。」、cancel「丢弃本批未完成的更新（已完成的将保留）。」、data-confirm 初始为空；A/B 行终态 0.0.2；C 行 ready、versionNew=0.0.2',
    actual: JSON.stringify({ more: moreOffer, rows: offerSeat.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur, next: row.versionNew })), disk: restartDisk }),
    verdict: offerTextsOk && offerRowsOk ? 'pass' : 'fail',
  })
  rec({ step: 'k4-07-resume-offer', what: '续跑入口出现且文案逐字（A/B 已完成不重复装，C 待续跑）', expected: 'resume/resumeTitle/cancel 文案逐字、data-confirm 为空；A/B 终态 0.0.2；C ready versionNew=0.0.2', actual: JSON.stringify({ more: moreOffer, rows: offerSeat.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur, next: row.versionNew })) }), ok: offerTextsOk && offerRowsOk })

  // ---- 5. 冻结窗：双闸下静置 8s 不自动续跑 ----
  const freezeTarballs = tarballRequestCount()
  const freezeDiskBefore = await diskVersions(ctx, [packageA, packageB, packageC])
  const freezeLedgerBefore = { b: ledgerBriefOf(await ledgerFor(ctx, packageB)), c: ledgerBriefOf(await ledgerFor(ctx, packageC)) }
  const freezeBatchBefore = (await diskBatchEntries(ctx)).map((entry) => entry.key + ':' + entry.phase).join('|')
  await sleep(8000)
  const freezeTarballsAfter = tarballRequestCount()
  const freezeDiskAfter = await diskVersions(ctx, [packageA, packageB, packageC])
  const freezeLedgerAfter = { b: ledgerBriefOf(await ledgerFor(ctx, packageB)), c: ledgerBriefOf(await ledgerFor(ctx, packageC)) }
  const freezeBatchAfter = (await diskBatchEntries(ctx)).map((entry) => entry.key + ':' + entry.phase).join('|')
  const freezeOk = freezeTarballsAfter === freezeTarballs && freezeDiskAfter[packageC] === freezeDiskBefore[packageC] && JSON.stringify(freezeLedgerAfter) === JSON.stringify(freezeLedgerBefore) && freezeBatchAfter === freezeBatchBefore
  await ctx.run.raw('k4-freeze-window', { tarballsBefore: freezeTarballs, tarballsAfter: freezeTarballsAfter, diskBefore: freezeDiskBefore, diskAfter: freezeDiskAfter, ledgerBefore: freezeLedgerBefore, ledgerAfter: freezeLedgerAfter, batchBefore: freezeBatchBefore, batchAfter: freezeBatchAfter, freezeOk })
  rec({ step: 'k4-08-frozen', what: '双闸冻结：续跑入口出现后 8 秒内不自动续跑', expected: 'tarball 请求数不变；C 磁盘不变；B/C 台账快照不变；批量会话相位不变', actual: JSON.stringify({ tarballs: [freezeTarballs, freezeTarballsAfter], diskC: [freezeDiskBefore[packageC], freezeDiskAfter[packageC]], batch: [freezeBatchBefore, freezeBatchAfter], freezeOk }), ok: freezeOk })

  // ---- 6. 真 UI 点续跑：只推进 C，A/B 不重复安装 ----
  await clickSeatAction(live2(), 'a', 'resume')
  const resumedNotice = await waitForBatchExtras(ui2, cardA, (extras) => extras.notice.indexOf('已继续上次未完成的更新') >= 0, 'K4 续跑回执', 120000)
  await waitDiskVersions(ctx, { [packageC]: FIXTURE_VARIANT_VERSION }, 'K4 续跑后 C 装到 0.0.2')
  const resumedSeat = await waitForBatchSeat(live2(), 'a', (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => terminalPhase(row.phase) && row.versionCur === FIXTURE_VARIANT_VERSION), { label: 'K4 续跑后三行 done/current 0.0.2', timeoutMs: 180000, intervalMs: 500 })
  const resumedDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const resumedExtras = await readBatchExtras(ui2, cardA).catch(() => null)
  const moreGone = resumedExtras !== null && resumedExtras.more === null
  const resumedOk = resumedNotice.notice.indexOf('已继续上次未完成的更新') >= 0 && resumedSeat.panel.rows.every((row) => terminalPhase(row.phase) && row.versionCur === FIXTURE_VARIANT_VERSION) && resumedDisk[packageA] === FIXTURE_VARIANT_VERSION && resumedDisk[packageB] === FIXTURE_VARIANT_VERSION && resumedDisk[packageC] === FIXTURE_VARIANT_VERSION && moreGone
  await capture(ctx.run, ui2, {
    step: 'k4-30-resumed',
    what: '点续跑后：C 装到 0.0.2、A/B 不重复安装；回执 + 三行完成 + 续跑区消失',
    expected: 'notice 含「已继续上次未完成的更新」；三行 current/done 0.0.2；磁盘三包 0.0.2；续跑区消失（more=null）',
    actual: JSON.stringify({ notice: resumedNotice.notice, rows: resumedSeat.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })), disk: resumedDisk, more: resumedExtras !== null ? resumedExtras.more : null }),
    verdict: resumedOk ? 'pass' : 'fail',
  })
  rec({ step: 'k4-09-resumed', what: '续跑完成：C 恢复到 0.0.2，回执与面板一致，续跑区收敛', expected: 'notice 含「已继续上次未完成的更新」；三行终态 0.0.2；磁盘三包 0.0.2；more=null', actual: JSON.stringify({ notice: resumedNotice.notice, rows: resumedSeat.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })), disk: resumedDisk, moreGone }), ok: resumedOk })

  // ---- 7. 停 gen2 → 后端 exactly-once / 台账逐行真相 ----
  await sleep(1000)
  await stopHostGen(ctx, gen2, 'k4-after-resume')
  const events = await readEvents(ctx)
  const execA = installExecsOf(events, packageA)
  const execB = installExecsOf(events, packageB)
  const execC = installExecsOf(events, packageC)
  const failA = installFailsOf(events, packageA)
  const failB = installFailsOf(events, packageB)
  const failsC = installFailsOf(events, packageC)
  const reqA = installRequestsOf(events, packageA)
  const reqB = installRequestsOf(events, packageB)
  const reqC = installRequestsOf(events, packageC)
  const execStageFailsOf = (records: readonly LogEventRecord[]): readonly LogEventRecord[] => records.filter((record) => record.fields['stage'] === 'exec')
  const execStageFailsC = execStageFailsOf(failsC)
  const audit = auditInstallFails(asAuditFacts(events))
  const jobsA = await ledgerJobsOf(ctx, packageA)
  const jobsB = await ledgerJobsOf(ctx, packageB)
  const jobsC = await ledgerJobsOf(ctx, packageC)
  const aAfterResume = ledgerBriefOf(await ledgerFor(ctx, packageA))
  const bAfterResume = ledgerBriefOf(await ledgerFor(ctx, packageB))
  // A 自更新触发插件宿主半重载时 exec 行可能被吞（K1 已知）；A 的不重复以「请求恰 1 次 + 台账行未被改写」为证，exec 仅辅助。
  const aExecSwallowed = okExecCount(execA) === 0
  const aLedgerUntouched = aBeforeKill !== null && aAfterResume !== null && aAfterResume.file === aBeforeKill.file && aAfterResume.id === aBeforeKill.id && aAfterResume.mtimeMs === aBeforeKill.mtimeMs && aAfterResume.state === aBeforeKill.state
  const bLedgerUntouched = bBeforeKill !== null && bAfterResume !== null && bAfterResume.file === bBeforeKill.file && bAfterResume.id === bBeforeKill.id && bAfterResume.mtimeMs === bBeforeKill.mtimeMs && bAfterResume.state === bBeforeKill.state
  const exactlyOnceOk = reqA.length === 1 && reqB.length === 1 && reqC.length === 2 && okExecCount(execB) === 1 && okExecCount(execC) === 1 && execStageFailsC.length === 1 && execStageFailsC[0] !== undefined && execStageFailsC[0].fields['code'] === 'install-failed' && execStageFailsOf(failA).length === 0 && execStageFailsOf(failB).length === 0 && okExecCount(execA) <= 1 && aLedgerUntouched && bLedgerUntouched
  await ctx.run.raw('k4-exactly-once', { exec: { a: execA, b: execB, c: execC }, req: { a: reqA.length, b: reqB.length, c: reqC.length }, failsC: execStageFailsC, audit, ledgerA: { beforeKill: aBeforeKill, afterResume: aAfterResume }, ledgerB: { beforeKill: bBeforeKill, afterResume: bAfterResume }, aExecSwallowed })
  rec({ step: 'k4-10-exactly-once', what: '续跑 exactly-once：A/B 请求各 1 次且台账未被改写；C 恰一次失败 + 恰一次成功', expected: 'reqA=1、reqB=1、reqC=2；B/C 各恰 1 次成功 exec；C stage=exec 失败恰 1（install-failed）；A/B 无 stage=exec 失败；A/B 台账 file/id/state/mtime 全不变；audit.nonCheckExpired=1', actual: JSON.stringify({ req: { a: reqA.length, b: reqB.length, c: reqC.length }, execOk: { a: okExecCount(execA), b: okExecCount(execB), c: okExecCount(execC) }, execFails: { a: execStageFailsOf(failA).length, b: execStageFailsOf(failB).length, c: execStageFailsC.length }, aLedgerUntouched, bLedgerUntouched, audit, aExecSwallowed }), note: aExecSwallowed ? 'A 自更新触发插件宿主半重载，exec 行被吞（K1 已知）；A 不重复以 install.request 恰 1 条 + 台账行未被改写为证。' : undefined, ok: exactlyOnceOk && audit.nonCheckExpired === 1 })
  const ledgerRows = [jobsA, jobsB, jobsC]
  const jobsOk = ledgerRows.every((jobs) => jobs.length === 1) && ledgerRows.every((jobs) => isSuccessLedger(jobs[0] as LedgerEntry) && jobs[0].state['targetVersion'] === FIXTURE_VARIANT_VERSION && jobs[0].state['previousVersion'] === FIXTURE_BASE_VERSION)
  rec({ step: 'k4-11-ledger-rows', what: '台账逐行真相：每包恰一条记录（同一 profile 只有一份 state.json，续跑覆盖不追加），三包终态成功；C 的失败历史只留在日志计数里', expected: 'A/B/C 各 1 条 state.json；state∈{completed,restart-required}；targetVersion=0.0.2；previousVersion=0.0.1', actual: JSON.stringify({ a: jobsA.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })), b: jobsB.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })), c: jobsC.map((entry) => ({ file: entry.file, state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })) }), ok: jobsOk })

  // ---- 8. gen3 重启：三行 current 0.0.2、总账/台账/卡片标记一致 ----
  const gen3 = await startHostGen(ctx, 'k4-gen3')
  const ui3 = uiOf(gen3)
  await waitForBatchSeat(webSessionOf(ui3.page), 'a', (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3, { label: 'K4 gen3 批量面板三行挂载', timeoutMs: 180000, intervalMs: 500 })
  await waitForBatchSeat(webSessionOf(ui3.page), 'a', (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === FIXTURE_VARIANT_VERSION), { label: 'K4 重启后批量面板三行 0.0.2', timeoutMs: 180000, intervalMs: 500 })
  await sleep(1500)
  const finalPanel = await readBatchSeat(webSessionOf(ui3.page), 'a')
  const tagsAfterA = await readCardTags(ui3, cardA)
  const tagsAfterB = await readCardTags(ui3, cardSelectorOf('b')).catch(() => null)
  const tagsAfterC = await readCardTags(ui3, cardSelectorOf('c')).catch(() => null)
  const finalDisk = await diskVersions(ctx, [packageA, packageB, packageC])
  const ledgerFinalA = await waitForLedger(ctx, packageA, ['completed'], 'K4 重启后 A 台账 completed', 90000)
  const ledgerFinalB = await waitForLedger(ctx, packageB, ['completed'], 'K4 重启后 B 台账 completed', 90000)
  const ledgerFinalC = await waitForLedger(ctx, packageC, ['completed'], 'K4 重启后 C 台账 completed', 90000)
  const restartRowsOk = finalPanel.panel.rows.length === 3 && finalPanel.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === FIXTURE_VARIANT_VERSION)
  const tagsOk = tagsAfterA.clientTag === tagsA.clientTag && tagsAfterA.hostTag === tagsA.hostTag && tagsAfterB !== null && tagsAfterB.clientTag === tagsB.clientTag && tagsAfterB.hostTag === tagsB.hostTag && tagsAfterC !== null && tagsAfterC.clientTag === tagsC.clientTag
  const restartLedgerOk = ledgerStateOf(ledgerFinalA) === 'completed' && ledgerStateOf(ledgerFinalB) === 'completed' && ledgerStateOf(ledgerFinalC) === 'completed'
  await capture(ctx.run, ui3, {
    step: 'k4-40-after-restart',
    what: '重启后：批量面板三行 current 0.0.2、总账「已全部为最新」、卡片构建标记 v0.0.2、台账三条 completed',
    expected: '三行 current 0.0.2；summary 含「已全部为最新」；ledger 含「3 个已是最新」；A/B clientTag/hostTag=v0.0.2、C clientTag=v0.0.2；台账三包 completed',
    actual: JSON.stringify({ rows: finalPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })), summary: finalPanel.panel.summary, ledger: finalPanel.panel.ledger, tagsA: tagsAfterA, tagsB: tagsAfterB, tagsC: tagsAfterC, disk: finalDisk, ledgerStates: { a: ledgerStateOf(ledgerFinalA), b: ledgerStateOf(ledgerFinalB), c: ledgerStateOf(ledgerFinalC) } }),
    verdict: restartRowsOk && tagsOk && restartLedgerOk && finalDisk[packageA] === FIXTURE_VARIANT_VERSION && finalDisk[packageB] === FIXTURE_VARIANT_VERSION && finalDisk[packageC] === FIXTURE_VARIANT_VERSION ? 'pass' : 'fail',
  })
  rec({ step: 'k4-12-restart-rows', what: '重启后批量行相位与版本（UI 与磁盘一致）', expected: '三行 current/done、versionCur=0.0.2', actual: JSON.stringify(finalPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur }))), ok: restartRowsOk })
  rec({ step: 'k4-13-restart-summary', what: '重启后总账/台账', expected: 'summary 含「已全部为最新」；ledger 含「3 个已是最新」', actual: JSON.stringify({ summary: finalPanel.panel.summary, ledger: finalPanel.panel.ledger }), ok: (finalPanel.panel.summary || '').indexOf('已全部为最新') >= 0 && (finalPanel.panel.ledger || '').indexOf('3 个已是最新') >= 0 })
  rec({ step: 'k4-14-build-tags', what: '三包运行内容都是 0.0.2 构建（不是版本号假成功）', expected: 'A/B clientTag/hostTag 与 C clientTag 都等于 0.0.2 变体标记', actual: JSON.stringify({ tagsA: tagsAfterA, tagsB: tagsAfterB, tagsC: tagsAfterC, expected: { a: tagsA, b: tagsB, c: tagsC } }), ok: tagsOk })
  rec({ step: 'k4-15-restart-ledger', what: '重启后台账三包各一条 completed（不重复/不丢）', expected: '三包 state=completed、targetVersion=0.0.2', actual: JSON.stringify({ a: ledgerStateOf(ledgerFinalA), b: ledgerStateOf(ledgerFinalB), c: ledgerStateOf(ledgerFinalC) }), ok: restartLedgerOk })
  rec({ step: 'k4-16-final-disk', what: '重启后磁盘三包仍 0.0.2（UI/台账/磁盘三处一致）', expected: '三包 versions=0.0.2', actual: JSON.stringify(finalDisk), ok: finalDisk[packageA] === FIXTURE_VARIANT_VERSION && finalDisk[packageB] === FIXTURE_VARIANT_VERSION && finalDisk[packageC] === FIXTURE_VARIANT_VERSION })
}

/** 台账终态证据的紧凑摘要（避免把整份 state.json 塞进断言串）。 */
function ledgeTermRaw(entries: { a: LedgerEntry | null; b: LedgerEntry | null; c: LedgerEntry | null }): Record<string, unknown> {
  const one = (entry: LedgerEntry | null): Record<string, unknown> | null => (entry === null ? null : { state: ledgerStateOf(entry), targetVersion: entry.state['targetVersion'] })
  return { a: one(entries.a), b: one(entries.b), c: one(entries.c) }
}

/** can-red：在 run 私有 home 里改掉已装 A 的 client bundle 文案（追加 RED），重启后对面板横幅做精确原文断言 ⇒ 唯一红点。 */
async function runCanRed(ctx: KContext, options: KUiScenarioOptions): Promise<void> {
  void options
  const rec = recorderFor(ctx.run)
  const packageA = FIXTURE_SLOT_A.packageName
  const cardA = cardSelectorOf('a')
  const panelA = '.dsh-upd[data-plugin="' + packageA + '"]'
  const expectedBanner = '已是最新，无需更新。'

  // ---- 1. 真 UI 走完单包装（复用 K1 前半）；停宿主后在已装包里做注入 ----
  const gen1 = await startHostGen(ctx, 'can-red-gen1', { delayMs: 6000, match: 'pnpm-user-agent' })
  const ui1 = uiOf(gen1)
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null, 'can-red A 面板挂载')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="check"]')
  await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'update', 'can-red 可更新横幅')
  await clickInCard(ui1, cardA, panelA + ' button[data-action="install"]')
  await waitDiskVersions(ctx, { [packageA]: FIXTURE_VARIANT_VERSION }, 'can-red A 装到 0.0.2')
  const settled1 = await waitForPanel(ui1, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', 'can-red 装完落定', 180000)
  const beforeOk = settled1.banner !== null && settled1.banner.title === expectedBanner
  await capture(ctx.run, ui1, {
    step: 'can-red-10-before-patch',
    what: '注入前对照：真 UI 装完 0.0.2 后面板横幅原文',
    expected: '横幅标题精确等于「已是最新，无需更新。」',
    actual: JSON.stringify(settled1.banner),
    verdict: beforeOk ? 'pass' : 'fail',
  })
  rec({ step: 'can-red-01-before-patch', what: '注入前基线：横幅原文精确匹配（证明断言在未改动时是绿的）', expected: '标题精确等于「已是最新，无需更新。」', actual: JSON.stringify(settled1.banner), ok: beforeOk })
  await stopHostGen(ctx, gen1, 'can-red-before-patch')

  // ---- 2. 只改 run 私有 home 里已装包的 client bundle（esbuild ascii 转义串），registry 与产品源码都不动 ----
  const clientFile = join(installedPluginDir({ homeDir: ctx.homeDir, profileName: PROFILE_NAME, packageName: packageA }), 'lib', 'client.js')
  const sha256Before = await sha256File(clientFile)
  const beforeText = await readFile(clientFile, 'utf8')
  const backslash = String.fromCharCode(92)
  const escaped = Array.from('已是最新，无需更新。').map((ch) => backslash + 'u' + (ch.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0')).join('')
  const occurrences = beforeText.split(escaped).length - 1
  if (occurrences < 1) throw new Error('can-red 注入点缺失：已装 A 的 client.js 里找不到横向转义串（occurrences=' + String(occurrences) + '）')
  const afterText = beforeText.split(escaped).join(escaped + 'RED')
  await writeFile(clientFile, afterText)
  const sha256After = await sha256File(clientFile)
  const patchFact = { file: clientFile, occurrences, escapedNeedle: escaped, charsBefore: beforeText.length, charsAfter: afterText.length, sha256Before, sha256After, changed: sha256Before !== sha256After }
  await ctx.run.raw('can-red-patch', patchFact)
  const patchOk = occurrences >= 1 && sha256Before !== sha256After
  rec({ step: 'can-red-02-patch-applied', what: '注入：run 私有 home 已装包 client bundle 的横幅文案被追加 RED（只动磁盘副本）', expected: 'occurrences>=1、sha256 前后不同', actual: JSON.stringify(patchFact), ok: patchOk })

  // ---- 3. 重启后精确原文断言：应渲染成「已是最新，无需更新。RED」⇒ 唯一红点 ----
  const gen2 = await startHostGen(ctx, 'can-red-gen2')
  const ui2 = uiOf(gen2)
  const after = await waitForPanel(ui2, cardA, panelA, (state) => state.banner !== null && state.banner.kind === 'done', 'can-red 重启后已了结横幅', 180000)
  const actualTitle = after.banner === null ? '' : after.banner.title
  const exactOk = actualTitle === expectedBanner
  await capture(ctx.run, ui2, {
    step: 'can-red-50-after-patch',
    what: '注入重启后：精确原文断言（可证伪点：若断言只做 includes 或没比对原文，这一格会假绿）',
    expected: '横幅标题精确等于「已是最新，无需更新。」',
    actual: JSON.stringify({ title: actualTitle, banner: after.banner }),
    verdict: exactOk ? 'pass' : 'fail',
  })
  rec({ step: 'can-red-03-banner-exact', what: '精确原文断言（真红点）：注入后实际渲染带 RED', expected: '标题精确等于「已是最新，无需更新。」', actual: JSON.stringify({ title: actualTitle }), ok: exactOk })
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
