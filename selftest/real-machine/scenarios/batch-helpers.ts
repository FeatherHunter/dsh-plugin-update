/**
 * selftest/real-machine/scenarios/batch-helpers.ts —— 批量场景（#266 T2 b/c）共用观测原语。
 *
 * 三件事（其余逻辑回场景文件）：
 *   1. DOM 快照：按稳定选择器抽「夹具卡片 / 批量面板行 / 批量入口 / 中枢坞」，actual 只从这里来；
 *   2. 真 UI 动作：卡片内 DOM click（点前 scrollIntoView；坐标点击在桌面/headless 不稳）；
 *   3. 磁盘/日志事实：批量账本、中枢计划、跨插件队列、结构化日志、隔离 profile 版本——
 *      UI 与磁盘两处独立取值再比对，不许拿「应该如此」当观测。
 */
import { cp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FixtureSlot, FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'
import { fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import type { RunLayout } from '../runtime/run-layout.ts'
import { readInstalledPackageVersion, readProfileManifest } from '../host/dsh-cli.ts'
import { directoryExists, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { waitFor } from '../../tooling/process.ts'

/** 一行批量面板的 DOM 事实。 */
export interface BatchRowState {
  readonly key: string | null
  readonly phase: string | null
  readonly queued: boolean
  readonly busy: boolean
  readonly title: string | null
  readonly status: string | null
  readonly versionCur: string | null
  readonly versionNew: string | null
  readonly actions: readonly (string | null)[]
  readonly fail: string | null
}

/** 一个批量面板的 DOM 事实。 */
export interface BatchPanelState {
  readonly present: boolean
  readonly mode: string | null
  readonly seal: string | null
  readonly rows: readonly BatchRowState[]
  readonly check: { readonly text: string | null; readonly disabled: boolean } | null
  readonly install: { readonly text: string | null; readonly disabled: boolean } | null
  readonly ledger: string | null
  readonly summary: string | null
  readonly notice: string | null
}

/** 一枚夹具卡片（集成方）的 DOM 事实。 */
export interface FixtureCardState {
  readonly present: boolean
  readonly key: string | null
  readonly ui: string | null
  readonly title: string | null
  readonly clientTag: string | null
  readonly hostTag: string | null
  readonly seatLine: { readonly attr: string | null; readonly text: string | null } | null
  readonly behavior: { readonly attr: string | null; readonly text: string | null } | null
  readonly dockHost: string | null
}

/** 一枚集成方卡片的全部观测（卡片 + 面板 + 入口 + 中枢坞 + 卡内 .dsh-upd 数）。 */
export interface BatchSeatState {
  readonly slotKey: FixtureSlotKey
  readonly card: FixtureCardState
  readonly panel: BatchPanelState
  readonly entry: { readonly present: boolean; readonly text: string | null; readonly variant: string | null } | null
  readonly dock: { readonly present: boolean; readonly title: string | null; readonly rows: number; readonly meta: string | null } | null
  readonly dshUpdCount: number
}

/** 纯目标徽标的 DOM 事实。 */
export interface TargetSeatState {
  readonly present: boolean
  readonly key: string | null
  readonly ui: string | null
  readonly wiring: string | null
  readonly clientTag: string | null
  readonly badgeText: string | null
  readonly dshUpdCount: number
  readonly dockCount: number
  readonly entryCount: number
}

/** 整页观测（证明「纯目标没有更新 UI」这种全局断言）。 */
export interface PageUpdateState {
  readonly fixtureKeys: readonly (string | null)[]
  readonly totalDshUpd: number
  readonly totalBatchPanels: number
  readonly totalDocks: number
  readonly totalEntries: number
}

/** 隔离 profile 的磁盘快照。 */
export interface DiskSnapshot {
  readonly versions: Record<string, string | null>
  readonly dependencies: Record<string, string | null>
  readonly manifest: unknown
}

/** 批量账本/中枢/队列的磁盘事实。 */
export interface BatchDiskFacts {
  readonly files: readonly string[]
  readonly owners: Record<string, { batch: unknown; inventory: unknown; prefs: unknown }>
  readonly queue: unknown | null
  readonly hubPlans: Record<string, unknown>
  readonly hubLease: unknown | null
}

/** 一条结构化日志事件。 */
export interface LogEventFact {
  readonly namespace: string
  readonly event: string
  readonly level: string
  readonly fields: Record<string, unknown>
}

/** 日志收集结果。 */
export interface LogFacts {
  readonly files: readonly string[]
  readonly contents: Record<string, string>
  readonly events: readonly LogEventFact[]
}

/** 一个卡片选择器（按席位键）。 */
export function cardSelectorOf(slotKey: string): string {
  return '.dsh-fixture-card[data-fixture="' + slotKey + '"]'
}

/** 读一枚集成方卡片的全部观测（一次页面求值；不用多个求值拼快照）。 */
export async function readBatchSeat(session: DesktopSession, slotKey: FixtureSlotKey): Promise<BatchSeatState> {
  const cardSel = JSON.stringify(cardSelectorOf(slotKey))
  const expression = [
    '(() => {',
    '  const card = document.querySelector(' + cardSel + ');',
    "  const txt = (el) => (el ? (el.textContent || '').trim() : null);",
    '  const attr = (el, name) => (el ? el.getAttribute(name) : null);',
    '  if (!card) {',
    '    return { slotKey: ' + JSON.stringify(slotKey) + ', card: { present: false, key: null, ui: null, title: null, clientTag: null, hostTag: null, seatLine: null, behavior: null, dockHost: null }, panel: { present: false, mode: null, seal: null, rows: [], check: null, install: null, ledger: null, summary: null, notice: null }, entry: null, dock: null, dshUpdCount: 0 };',
    '  }',
    "  const panel = card.querySelector('.dsh-upd-batch');",
    "  const rows = Array.from(card.querySelectorAll('.dsh-upd-brow-set[data-key]')).map((set) => {",
    "    const row = set.querySelector('.dsh-upd-brow[data-key]');",
    "    const main = set.querySelector('.dsh-upd-brow-main[data-key]');",
    "    const versionEl = main ? main.querySelector('.dsh-upd-bver') : null;",
    "    const versionCur = main ? (txt(main.querySelector('.dsh-upd-bver-cur')) || (versionEl && !main.querySelector('.dsh-upd-bver-cur') ? txt(versionEl) : null)) : null;",
    "    const versionNew = main ? (txt(main.querySelector('.dsh-upd-bver-new')) || txt(main.querySelector('.dsh-upd-bver-new-ok'))) : null;",
    '    return {',
    "      key: set.getAttribute('data-key'),",
    "      phase: row ? row.getAttribute('data-phase') : null,",
    "      queued: row ? row.getAttribute('data-queued') === '1' : false,",
    "      busy: !!set.querySelector('[data-busy=\"1\"]'),",
    "      title: txt(set.querySelector('.dsh-upd-bname')),",
    "      status: txt(set.querySelector('.dsh-upd-bstat')),",
    '      versionCur: versionCur,',
    '      versionNew: versionNew,',
    "      actions: Array.from(set.querySelectorAll('button[data-act][data-key]')).map((el) => el.getAttribute('data-act')),",
    "      fail: txt(set.querySelector('.dsh-upd-bfail')),",
    '    };',
    '  });',
    "  const macro = (act) => { const el = card.querySelector('.dsh-upd-batch button[data-act=\"' + act + '\"]'); return el ? { text: txt(el), disabled: el.hasAttribute('disabled') } : null; };",
    "  const entryEl = card.querySelector('[data-dsh-upd-entry]');",
    "  const dockEl = card.querySelector('.dsh-hub-dock');",
    "  const seat = card.querySelector('[data-fixture-seat-line]');",
    "  const behavior = card.querySelector('[data-fixture-behavior]');",
    "  const behaviorTextEl = card.querySelector('[data-fixture-behavior-text]');",
    '  return {',
    '    slotKey: ' + JSON.stringify(slotKey) + ',',
    '    card: {',
    '      present: true,',
    "      key: attr(card, 'data-fixture'),",
    "      ui: attr(card, 'data-fixture-ui'),",
    "      title: txt(card.querySelector('[data-fixture-section=title]')),",
    "      clientTag: attr(card, 'data-build-tag'),",
    "      hostTag: txt(card.querySelector('[data-fixture-host-tag]')),",
    "      seatLine: seat ? { attr: attr(seat, 'data-fixture-seat-line'), text: txt(seat) } : null,",
    "      behavior: behavior ? { attr: attr(behavior, 'data-fixture-behavior'), text: txt(behaviorTextEl) || txt(behavior) } : null,",
    "      dockHost: attr(card.querySelector('[data-fixture-dock]'), 'data-fixture-dock'),",
    '    },',
    '    panel: {',
    '      present: !!panel,',
    "      mode: attr(panel, 'data-mode'),",
    "      seal: attr(panel, 'data-seal'),",
    '      rows: rows,',
    "      check: macro('check'),",
    "      install: macro('install'),",
    "      ledger: txt(card.querySelector('.dsh-upd-batch-ledger')),",
    "      summary: txt(card.querySelector('.dsh-upd-batch-sum')),",
    "      notice: txt(card.querySelector('.dsh-upd-batch-notice')),",
    '    },',
    "    entry: entryEl ? { present: true, text: txt(entryEl), variant: attr(entryEl, 'data-variant') } : null,",
    "    dock: dockEl ? { present: true, title: txt(dockEl.querySelector('.dsh-hub-dock-title')), rows: dockEl.querySelectorAll('.dsh-hub-dock-row').length, meta: txt(dockEl.querySelector('.dsh-hub-dock-meta')) } : null,",
    "    dshUpdCount: card.querySelectorAll('.dsh-upd').length,",
    '  };',
    '})()',
  ].join('\n')
  return session.cdp.evaluate<BatchSeatState>(expression)
}

/** 读纯目标徽标（C 席位；没有更新 UI 的证据从这里取）。 */
export async function readTargetSeat(session: DesktopSession, slotKey: FixtureSlotKey): Promise<TargetSeatState> {
  const cardSel = JSON.stringify(cardSelectorOf(slotKey))
  const expression = [
    '(() => {',
    '  const card = document.querySelector(' + cardSel + ');',
    "  const txt = (el) => (el ? (el.textContent || '').trim() : null);",
    '  const attr = (el, name) => (el ? el.getAttribute(name) : null);',
    '  if (!card) return { present: false, key: null, ui: null, wiring: null, clientTag: null, badgeText: null, dshUpdCount: 0, dockCount: 0, entryCount: 0 };',
    '  return {',
    '    present: true,',
    "    key: attr(card, 'data-fixture'),",
    "    ui: attr(card, 'data-fixture-ui'),",
    "    wiring: attr(card, 'data-update-wiring'),",
    "    clientTag: attr(card, 'data-build-tag'),",
    '    badgeText: txt(card),',
    "    dshUpdCount: card.querySelectorAll('.dsh-upd').length,",
    "    dockCount: card.querySelectorAll('.dsh-hub-dock').length,",
    "    entryCount: card.querySelectorAll('[data-dsh-upd-entry]').length,",
    '  };',
    '})()',
  ].join('\n')
  return session.cdp.evaluate<TargetSeatState>(expression)
}

/** 读整页更新 UI 计数（证明纯目标没有面板/入口，集成方各有一份）。 */
export async function readPageUpdateState(session: DesktopSession): Promise<PageUpdateState> {
  return session.cdp.evaluate<PageUpdateState>([
    '(() => ({',
    "  fixtureKeys: Array.from(document.querySelectorAll('.dsh-fixture-card')).map((el) => el.getAttribute('data-fixture')),",
    "  totalDshUpd: document.querySelectorAll('.dsh-upd').length,",
    "  totalBatchPanels: document.querySelectorAll('.dsh-upd-batch').length,",
    "  totalDocks: document.querySelectorAll('.dsh-hub-dock').length,",
    "  totalEntries: document.querySelectorAll('[data-dsh-upd-entry]').length,",
    '}))()',
  ].join('\n'))
}

/** 等一枚集成方卡片达到预期（probe 内吞页面重渲染异常，超时由 waitFor 抛）。 */
export async function waitForBatchSeat(
  session: DesktopSession,
  slotKey: FixtureSlotKey,
  predicate: (state: BatchSeatState) => boolean,
  options: { label: string; timeoutMs: number; intervalMs?: number },
): Promise<BatchSeatState> {
  return waitFor(
    options.label,
    async () => {
      try {
        const state = await readBatchSeat(session, slotKey)
        return predicate(state) ? state : null
      } catch (error) {
        return null
      }
    },
    { timeoutMs: options.timeoutMs, intervalMs: options.intervalMs || 500 },
  )
}

/** 等纯目标徽标达到预期。 */
export async function waitForTargetSeat(
  session: DesktopSession,
  slotKey: FixtureSlotKey,
  predicate: (state: TargetSeatState) => boolean,
  options: { label: string; timeoutMs: number; intervalMs?: number },
): Promise<TargetSeatState> {
  return waitFor(
    options.label,
    async () => {
      try {
        const state = await readTargetSeat(session, slotKey)
        return predicate(state) ? state : null
      } catch (error) {
        return null
      }
    },
    { timeoutMs: options.timeoutMs, intervalMs: options.intervalMs || 500 },
  )
}

/** 点卡片内的一个动作（可限定行 key）；点前 scrollIntoView。 */
export async function clickSeatAction(session: DesktopSession, slotKey: FixtureSlotKey, act: string, rowKey?: string): Promise<void> {
  const cardSel = cardSelectorOf(slotKey)
  const rowPart = rowKey === undefined ? '' : '[data-key="' + rowKey + '"]'
  const selector = cardSel + ' button[data-act="' + act + '"]' + rowPart
  await session.cdp.waitForSelector(selector, { timeoutMs: 30000 })
  await session.cdp.scrollIntoView(selector)
  await session.cdp.clickSelector(selector)
}

/** 点击页面内第一个存在的选择器（确认/兜底弹层；没有就返回 null，不等待）。 */
export async function clickFirstPresent(session: DesktopSession, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) {
    const found = await session.cdp.evaluate<boolean>('!!document.querySelector(' + JSON.stringify(selector) + ')').catch(() => false)
    if (!found) continue
    await session.cdp.scrollIntoView(selector)
    await session.cdp.clickSelector(selector)
    return selector
  }
  return null
}

/** 批量安装可能出现的确认按钮（合规/兜底分支）；场景在等进度时顺带点掉。 */
export const BATCH_CONFIRM_SELECTORS: readonly string[] = [
  '[data-act="batch-fallback-confirm"]',
  '[data-act="row-fallback-confirm"]',
  '[data-act="confirm"]',
]

/** 读隔离 profile 里若干夹具包的磁盘事实（版本 + dependencies）。 */
export async function readDiskSnapshot(options: {
  readonly homeDir: string
  readonly profileName: string
  readonly packageNames: readonly string[]
}): Promise<DiskSnapshot> {
  const versions: Record<string, string | null> = {}
  for (const packageName of options.packageNames) {
    versions[packageName] = await readInstalledPackageVersion({
      homeDir: options.homeDir,
      profileName: options.profileName,
      packageName,
    }).catch(() => null)
  }
  const profileDir = join(options.homeDir, 'profiles', options.profileName)
  const manifest = (await readProfileManifest(profileDir).catch(() => null)) as
    | { dependencies?: Record<string, string> }
    | null
  const dependencies: Record<string, string | null> = {}
  for (const packageName of options.packageNames) {
    dependencies[packageName] = (manifest && manifest.dependencies && manifest.dependencies[packageName]) || null
  }
  return { versions, dependencies, manifest }
}

/** 等磁盘版本达到预期（每个包逐个核对；超时抛错，调用方把实际快照落 raw）。 */
export async function waitForDiskVersions(
  options: { readonly homeDir: string; readonly profileName: string; readonly packageNames: readonly string[] },
  expected: Record<string, string>,
  waitOptions: { label: string; timeoutMs: number; intervalMs?: number },
): Promise<DiskSnapshot> {
  return waitFor(
    waitOptions.label,
    async () => {
      const snapshot = await readDiskSnapshot(options)
      const matched = options.packageNames.every((packageName) => {
        const want = expected[packageName]
        return want === undefined || snapshot.versions[packageName] === want
      })
      return matched ? snapshot : null
    },
    { timeoutMs: waitOptions.timeoutMs, intervalMs: waitOptions.intervalMs || 1500 },
  )
}

/** 读批量账本/中枢计划/根队列（磁盘事实；UI 断言不能拿这些当 actual）。 */
export async function readBatchDiskFacts(homeDir: string): Promise<BatchDiskFacts> {
  const root = join(homeDir, 'update-queue')
  const files: string[] = []
  const owners: Record<string, { batch: unknown; inventory: unknown; prefs: unknown }> = {}
  const hubPlans: Record<string, unknown> = {}
  let queue: unknown | null = null
  let hubLease: unknown | null = null
  if (!(await directoryExists(root))) return { files, owners, queue, hubPlans, hubLease }
  const parse = async (absolute: string): Promise<unknown> => {
    const content = await readFile(absolute, 'utf8').catch(() => '')
    try {
      return JSON.parse(content) as unknown
    } catch (error) {
      return null
    }
  }
  for (const rel of await listFilesRecursive(root)) {
    files.push(rel)
    const absolute = join(root, rel.split('/').join('\\'))
    const segments = rel.split('/')
    const base = segments[segments.length - 1] || ''
    const parent = segments[segments.length - 2] || ''
    if (base === 'batch.json' || base === 'inventory.json' || base === 'prefs.json') {
      const owner = owners[parent] || { batch: null, inventory: null, prefs: null }
      const parsed = await parse(absolute)
      if (base === 'batch.json') owner.batch = parsed
      else if (base === 'inventory.json') owner.inventory = parsed
      else owner.prefs = parsed
      owners[parent] = owner
    } else if (base === 'queue.json') {
      queue = await parse(absolute)
    } else if (base === 'lease.json' && rel.indexOf('hub/') >= 0) {
      hubLease = await parse(absolute)
    } else if (base.endsWith('.json') && parent === 'plans') {
      hubPlans[base.slice(0, -5)] = await parse(absolute)
    }
  }
  return { files, owners, queue, hubPlans, hubLease }
}

/** 读结构化日志（home/logs/<namespace>/<date>.log，一行一个 JSON）。 */
export async function readLogFacts(homeDir: string): Promise<LogFacts> {
  const root = join(homeDir, 'logs')
  const files: string[] = []
  const contents: Record<string, string> = {}
  const events: LogEventFact[] = []
  if (!(await directoryExists(root))) return { files, contents, events }
  for (const rel of await listFilesRecursive(root)) {
    if (!rel.endsWith('.log')) continue
    files.push(rel)
    const absolute = join(root, rel.split('/').join('\\'))
    const content = await readFile(absolute, 'utf8').catch(() => '')
    contents[rel] = content.slice(0, 50000)
    const namespace = rel.split('/')[0] || ''
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { event?: unknown; level?: unknown; fields?: unknown }
        events.push({
          namespace,
          event: String(parsed.event || ''),
          level: String(parsed.level || ''),
          fields: (parsed.fields || {}) as Record<string, unknown>,
        })
      } catch (error) {
        // 契约外的坏行不进结构化断言；整份原文已进 raw。
      }
    }
  }
  return { files, contents, events }
}

/** 设计内首提拒绝审计（#70 / ADR-0004 §3 A 案：≥2 家批每家首次提交都可能 check-expired，当场重查重提）。 */
export interface InstallFailAudit {
  /** 真失败口径的 update.install.fail 条数（不含 update-busy 排队回执）。 */
  readonly failCount: number
  /** update.install.retry 条数。 */
  readonly retryCount: number
  /** 非 check-expired 的 install.fail 条数（必须是 0；否则是真失败）。 */
  readonly nonCheckExpired: number
  /** 每条 check-expired 拒绝后、同一命名空间内没有 retry 的条数（必须是 0）。 */
  readonly unretried: number
  /** code=update-busy 的排队回执条数（#25 语义：不是失败，驱动器下一轮重推）。 */
  readonly queuedCount: number
  /** 出现过真失败 install.fail 的命名空间（附在 actual 里便于定位）。 */
  readonly namespaces: readonly string[]
}

export function auditInstallFails(events: readonly LogEventFact[]): InstallFailAudit {
  const byNamespace = new Map<string, LogEventFact[]>()
  for (const event of events) {
    const list = byNamespace.get(event.namespace) || []
    list.push(event)
    byNamespace.set(event.namespace, list)
  }
  let failCount = 0
  let retryCount = 0
  let nonCheckExpired = 0
  let unretried = 0
  let queuedCount = 0
  const namespaces: string[] = []
  for (const [namespace, list] of byNamespace) {
    let failed = false
    list.forEach((event, index) => {
      if (event.event === 'update.install.retry') retryCount += 1
      if (event.event !== 'update.install.fail') return
      const code = String(event.fields['code'] || event.fields['errorKind'] || '')
      // update-busy：另一个安装持有全局锁，phone 回 {kind:'queued'}，驱动器下一轮重推（不是失败）。
      if (code === 'update-busy') {
        queuedCount += 1
        return
      }
      failCount += 1
      failed = true
      if (code !== 'check-expired') nonCheckExpired += 1
      const retried = list.slice(index + 1).some((later) => later.event === 'update.install.retry' && (String(later.fields['reason'] || '') === 'check-expired' || Number(later.fields['attempt'] || 0) >= 2))
      if (!retried) unretried += 1
    })
    if (failed) namespaces.push(namespace)
  }
  return { failCount, retryCount, nonCheckExpired, unretried, queuedCount, namespaces }
}

/**
 * 把一次 run 的证据包复制进仓库：run.json + index.md + raw/ + shots/。
 * 隔离 home/registry/fixtures/pack/user-data-dir 留在仓库外 runtime（README §1）。
 */
export async function copyRunEvidence(layout: RunLayout, worktree: string): Promise<string> {
  const target = join(worktree, 'selftest', 'evidence', 'runs', layout.runId)
  await mkdir(target, { recursive: true })
  for (const name of ['run.json', 'index.md']) {
    await cp(join(layout.root, name), join(target, name), { force: true }).catch(() => undefined)
  }
  for (const dir of ['raw', 'shots']) {
    await cp(join(layout.root, dir), join(target, dir), { recursive: true, force: true }).catch(() => undefined)
  }
  return target
}

/** 按席位键取「目标键清单」（场景断言与席位声明对齐用）。 */
export function targetKeysOf(slot: FixtureSlot): readonly string[] {
  if (!slot.batch) return []
  return slot.batch.targets.map((target) => target.key)
}

/** 夹具包名清单（某场景装的全部席位）。 */
export function packageNamesOfSlots(slots: readonly FixtureSlot[]): readonly string[] {
  return slots.map((slot) => slot.packageName)
}

/** 场景里按席位键取槽位。 */
export function slotOfKey(key: FixtureSlotKey): FixtureSlot {
  return fixtureSlotOf(key)
}

/** 面板行按 key 取（区分「没有这一行」与「行状态不对」）。 */
export function rowOf(state: BatchSeatState, key: string): BatchRowState | null {
  return state.panel.rows.find((row) => row.key === key) || null
}

/** 面板行 key 顺序（UI 顺序 = 批量会话顺序，断言 B 的 targets 是否照声明）。 */
export function rowKeysOf(state: BatchSeatState): readonly (string | null)[] {
  return state.panel.rows.map((row) => row.key)
}

/** 页面里一个元素的矩形（局部截图用；找不到返回 null）。 */
export async function elementRect(session: DesktopSession, selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const expression = [
    '(() => {',
    '  const el = document.querySelector(' + JSON.stringify(selector) + ');',
    '  if (!el) return null;',
    '  const rect = el.getBoundingClientRect();',
    '  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };',
    '})()',
  ].join('\n')
  return session.cdp.evaluate<{ x: number; y: number; width: number; height: number } | null>(expression)
}

/** 落一张元素局部截图（整窗图之外再给「这一块」的近距离证据）。 */
export async function captureClippedShot(
  recorder: import('../runtime/evidence.ts').EvidenceRecorder,
  session: DesktopSession,
  selector: string,
  meta: { step: string; what: string; expected: string; actual: string; verdict: 'pass' | 'fail' | 'known-red' | 'unknown'; note?: string },
): Promise<void> {
  const rect = await elementRect(session, selector)
  if (!rect) throw new Error('[scenarios] 局部截图目标不存在：' + selector)
  const clip = {
    x: Math.max(0, rect.x - 8),
    y: Math.max(0, rect.y - 8),
    width: Math.max(1, rect.width + 16),
    height: Math.max(1, rect.height + 16),
    scale: 1,
  }
  const png = await session.cdp.screenshot({ clip, timeoutMs: 60000 })
  await recorder.shot('shot', png, meta)
}
