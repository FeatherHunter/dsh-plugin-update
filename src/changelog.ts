/**
 * src/changelog.ts —— 包内 CHANGELOG.md 的纯解析与面板渲染（#23，承接 #11 取证）。
 *
 * 取证结论（research/changelog-optimal-form.md）：
 * 包内 `CHANGELOG.md`（包根 + files 白名单已落地）是唯一推荐数据源；
 * Keep-a-Changelog 子集；缺日志中性提示、不挡安装。
 *
 * 本模块零依赖、纯函数、无 Node/浏览器专属能力，两边都跑得动：
 * 解析只做字符串切分，不读盘、不联网；版本语义与核心同口径
 * （validReleaseVersion / compareReleaseVersions，stable 纯三段、prerelease 显式）。
 *
 * 面板约定（#23 原文 + #41 四处优化终裁）：
 * - `Added/Fixed/Changed/Security` 必显展开；`Deprecated/Removed` 透传折叠；
 * - `Unreleased` 与空节忽略；
 * - 缺日志中性提示，不挡安装、不写 blockedReason、不动快照六字段
 *   （本模块不碰快照，面板只增一节 HTML，安装门控只跟快照）；
 * - 已装版离线读、新版按需取 tarball 同名文件复用官方源 integrity
 *   （I/O 在 `src/changelog-io.ts` Node 侧，取不到回落中性提示）；
 * - 纯函数解析器（仅复用版本语义，不碰 Node 专属；新增 validate 与策略函数零新增导入）。
 * - 截断数值不动（100 节/每类 200 条/单条 500 字/全文 64K），解析附计数元数据只记数字；
 *   超限类标计数小字，Security 超限进内折叠；BREAKING 前缀识别 + 行首徽标；yanked 横幅只看 to 版。
 */

import { compareReleaseVersions, validReleaseVersion } from './service.js'
import { copyText } from './bilingual.js'
import { normalizeLangTag, type AppLang } from './lang.js'

/** 包内日志文件名（包根，与 tarball 内同名文件同一名字）。 */
export const CHANGELOG_FILENAME = 'CHANGELOG.md'

/** 缺日志时的中性提示（不挡安装，安装按钮状态不变；zh 原文，渲染走字典 changelog.neutral.hint，留常量只为兼容既有导入）。 */
export const CHANGELOG_NEUTRAL_HINT = '作者未提供更新说明'

/** 中性提示完整行（含“安装不受影响”，把“不挡安装”说成人话；渲染走字典 changelog.neutral.line）。 */
export const CHANGELOG_NEUTRAL_LINE = '作者未提供更新说明，安装不受影响。'

/** 输入上限（字符）：超限截断后解析，永不抛错、不OOM。 */
export const CHANGELOG_MAX_CHARS = 64 * 1024
/** 版本节上限：超限只取文件顺序前 N 节（Keep-a-Changelog 最新在前）。 */
export const CHANGELOG_MAX_ENTRIES = 100
/** 每类条目上限：超限只取前 N 条。 */
export const CHANGELOG_MAX_BULLETS_PER_SECTION = 200
/** 单条上限（字符）：超限在尾部截断并加省略号。 */
export const CHANGELOG_MAX_BULLET_CHARS = 500

/** 六类全集（Keep-a-Changelog #types 节）。 */
export const CHANGELOG_ALL_CATEGORIES = [
  'Added',
  'Fixed',
  'Changed',
  'Deprecated',
  'Removed',
  'Security',
] as const
export type ChangelogCategory = (typeof CHANGELOG_ALL_CATEGORIES)[number]

/** 必显三类（面板展开渲染）。 */
export const CHANGELOG_MUST_SHOW: readonly ChangelogCategory[] = ['Added', 'Fixed', 'Changed', 'Security']
/** 透传折叠三类（原样展示、不解析、不参与“有无新版”判断）。 */
export const CHANGELOG_FOLDED: readonly ChangelogCategory[] = ['Deprecated', 'Removed']

/** 六类中文名（面板双语标题用，顺序与英文一一对应）。 */
export const CHANGELOG_CATEGORY_ZH: Record<ChangelogCategory, string> = {
  Added: '新增',
  Fixed: '修复',
  Changed: '变更',
  Deprecated: '弃用预告',
  Removed: '移除',
  Security: '安全',
}

/** 一节版本（Unreleased 也保留在解析结果里，渲染与区间筛选时忽略）。 */
export interface ChangelogEntry {
  /** 归一化版本号：`Unreleased` 或发行版本号（如 `1.2.3`、`1.2.3-rc.1`）。 */
  version: string
  /** 标题里的 ISO 日期（`YYYY-MM-DD`），没有为 null。 */
  date: string | null
  /**
   * 标题带 `[YANKED]` 标记（仅文本提示，不做机器信号：区间照算，渲染补“已撤回”）。
   * 对抗复查补记：Keep-a-Changelog 要求 yanked 可见，本模块此前直接丢掉标记。
   */
  yanked: boolean
  /** 六类各自的条目（空类为空数组，空节忽略由渲染层执行）。 */
  sections: Record<ChangelogCategory, string[]>
  /** 每类原始条数（截断前计数，只记数字不留文本；缺省视为与 sections 等长）。 */
  counts?: Record<ChangelogCategory, number>
}

function emptySections(): Record<ChangelogCategory, string[]> {
  return { Added: [], Fixed: [], Changed: [], Deprecated: [], Removed: [], Security: [] }
}

function emptyCounts(): Record<ChangelogCategory, number> {
  return { Added: 0, Fixed: 0, Changed: 0, Deprecated: 0, Removed: 0, Security: 0 }
}

function isCategoryName(v: string): v is ChangelogCategory {
  return (CHANGELOG_ALL_CATEGORIES as readonly string[]).includes(v)
}

function normalizeCategory(raw: string): ChangelogCategory | null {
  const t = String(raw || '').trim().toLowerCase()
  if (t === 'added') return 'Added'
  if (t === 'fixed') return 'Fixed'
  if (t === 'changed') return 'Changed'
  if (t === 'deprecated') return 'Deprecated'
  if (t === 'removed') return 'Removed'
  if (t === 'security') return 'Security'
  // 中文名（与 CHANGELOG_CATEGORY_ZH 同一表，不另起第二映射；精确匹配，不做子串，
  // 免得「新增功能」这类标题被误收到 Added——归因污染比漏收更坏）。
  for (const k of CHANGELOG_ALL_CATEGORIES) {
    if (t === CHANGELOG_CATEGORY_ZH[k]) return k
  }
  return null
}

/** 是否 Unreleased（大小写不敏感，前后空白忽略）。 */
export function isUnreleasedVersion(v: unknown): boolean {
  return typeof v === 'string' && v.trim().toLowerCase() === 'unreleased'
}

function extractVersionDateAndYanked(title: string): { version: string | null; date: string | null; yanked: boolean } {
  const t = String(title || '').trim()
  if (!t) return { version: null, date: null, yanked: false }
  const yanked = /\[YANKED\]/i.test(t)
  if (/unreleased/i.test(t)) return { version: 'Unreleased', date: null, yanked }
  // 对抗复查收紧：版本号在标题任意位置出现即收（`## Version 1.1.0`、无空格 `##[1.1.0]`、
  // 可链接标题 `## [1.1.0](url) - date` 均可；此前只看首 token/首括号，真实日志大量漏收）。
  // 取第一个命中的三段形态；日期用连字符，不会误命中版本号的点分形态。
  const vm = t.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)
  if (!vm) return { version: null, date: null, yanked: false }
  const dm = t.match(/(\d{4}-\d{2}-\d{2})/)
  return { version: vm[1], date: dm ? dm[1] : null, yanked }
}

function truncateBullet(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (t.length <= CHANGELOG_MAX_BULLET_CHARS) return t
  return `${t.slice(0, CHANGELOG_MAX_BULLET_CHARS - 1)}…`
}

/**
 * 解析 CHANGELOG Markdown（纯函数，永不抛错）：
 * 非字符串/空串回 []；超长截断后解析；未知版本标题与其下条目一律丢弃；
 * 全空节版本直接丢弃（空节忽略）；Unreleased 保留（渲染与区间时忽略）。
 */
/** 共享扫描仪（parse 与 validate 同一套，不许第二套正则）。 */
export const RE_VERSION_HEADING = /^##(?!#)\s*(.+?)\s*$/;
export const RE_CATEGORY_HEADING = /^###\s*(.+?)\s*$/;
export const RE_BULLET = /^\s*[-*+]\s+(.+?)\s*$/;
export const RE_FENCE_TOGGLE = new RegExp('^\\s*(' + String.fromCharCode(96).repeat(3) + '|~~~)');
export const RE_VERSION_NUM = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
export const RE_VERSION_DATE = /(\d{4}-\d{2}-\d{2})/;
export const RE_YANKED = /\[YANKED\]/i;
export const RE_UNRELEASED = /unreleased/i;

export function matchVersionHeading(line: unknown): string | null {
  try {
    const s = String(line !== null && line !== undefined ? line : '');
    const m = s.match(RE_VERSION_HEADING);
    if (!m) return null;
    return String(m[1] !== undefined && m[1] !== null ? m[1] : '').trim();
  } catch { return null; }
}

export function matchCategoryHeading(line: unknown): string | null {
  try {
    const s = String(line !== null && line !== undefined ? line : '');
    const m = s.match(RE_CATEGORY_HEADING);
    if (!m) return null;
    return String(m[1] !== undefined && m[1] !== null ? m[1] : '').trim();
  } catch { return null; }
}

export function matchBulletBody(line: unknown): string | null {
  try {
    const s = String(line !== null && line !== undefined ? line : '');
    const m = s.match(RE_BULLET);
    if (!m) return null;
    return String(m[1] !== undefined && m[1] !== null ? m[1] : '');
  } catch { return null; }
}

export function isFenceToggle(line: unknown): boolean {
  try { return RE_FENCE_TOGGLE.test(String(line !== null && line !== undefined ? line : '')); }
  catch { return false; }
}

/** 破坏标记徽标文案（中文 UI 一致，原文前缀另行加粗保留；渲染走字典 changelog.breaking.badge/aria，留常量只为兼容既有导入）。 */
export const BREAKING_BADGE_TEXT = '不兼容';

/** 六类标题按当前语言单语组装（#66，唯一源仍是 CATEGORY_ZH，不另起第二套映射）：中文「新增（Added）」观感、英文「Added」。 */
export function changelogCategoryLabel(cat: ChangelogCategory, lang?: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? 'zh')
  const zh = CHANGELOG_CATEGORY_ZH[cat]
  if (l === 'en') return cat
  return zh + '（' + cat + '）'
}

/** 折叠类标题（含条数）：中文「弃用预告（Deprecated）（3）」/英文「Deprecated (3)」；条数是变量值，不译。 */
export function changelogFoldedLabel(cat: ChangelogCategory, count: number, lang?: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? 'zh')
  const n = String(Math.floor(count))
  if (l === 'en') return cat + ' (' + n + ')'
  return CHANGELOG_CATEGORY_ZH[cat] + '（' + cat + '）（' + n + '）'
}

/** 剥行首 markdown 装饰（加粗/引用/前后空白），只为识别，渲染保留原文一字不动。 */
export function stripBreakingDecorations(s: unknown): string {
  try {
    let t = String(s !== null && s !== undefined ? s : '').trim();
    let changed = true;
    while (changed) {
      changed = false;
      if (t.charAt(0) === '>') { t = t.slice(1).trim(); changed = true; continue; }
      if (t.slice(0, 2) === '**' || t.slice(0, 2) === '__') { t = t.slice(2).trim(); changed = true; continue; }
      if (t.charAt(0) === '*' || t.charAt(0) === '_') { t = t.slice(1).trim(); changed = true; continue; }
    }
    return t;
  } catch { return ''; }
}

/** 条目是否为破坏标记（去饰后开头匹配，大小写不敏感，中英文冒号皆可）。 */
export function isBreakingChangelogItem(item: unknown): boolean {
  try {
    if (typeof item !== 'string') return false;
    const t = stripBreakingDecorations(item);
    if (!t) return false;
    return /^(breaking|不兼容)\s*[:：]/i.test(t);
  } catch { return false; }
}

/** 拆出破坏前缀（保留原文拼写与冒号），命中才回，否则 null。 */
export function splitBreakingPrefix(item: string): { head: string; prefix: string; rest: string } | null {
  try {
    const s = String(item !== null && item !== undefined ? item : '');
    const m = s.match(/^(\s*(?:>\s*|\*\*\s*|__\s*|\*\s*|_\s*)*)(breaking|不兼容)(\s*[:：])/i);
    if (!m) return null;
    const head = String(m[1] !== undefined && m[1] !== null ? m[1] : '');
    const core = String(m[2] !== undefined && m[2] !== null ? m[2] : '');
    const colon = String(m[3] !== undefined && m[3] !== null ? m[3] : '');
    const prefix = core + colon;
    const rest = s.slice(m[0].length);
    return { head: head, prefix: prefix, rest: rest };
  } catch { return null; }
}

/** 轮询退避（毫秒）：传输失败后轮询按此退避，手动/换版/重开立即重问。 */
export const CHANGELOG_POLL_BACKOFF_MS = 30 * 1000;

/** 三处共用（宿主电话/单面板/批量按行，各存各的）：成功与取不到已记住即不再问。 */
export function shouldFetchChangelog(opts: { hasCache: boolean; failedAt: number | null; now: number; isManual: boolean; backoffMs?: number }): boolean {
  try {
    const o = opts as { hasCache?: unknown; failedAt?: unknown; now?: unknown; isManual?: unknown; backoffMs?: unknown };
    if (o.hasCache === true) return false;
    if (o.isManual === true) return true;
    const now = typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : Date.now();
    const failedAt = typeof o.failedAt === 'number' && Number.isFinite(o.failedAt) ? o.failedAt : null;
    if (failedAt === null) return true;
    const backoff = typeof o.backoffMs === 'number' && Number.isFinite(o.backoffMs) && o.backoffMs > 0 ? Math.floor(o.backoffMs) : CHANGELOG_POLL_BACKOFF_MS;
    return now - failedAt >= backoff;
  } catch { return true; }
}

export function parseChangelog(markdown: unknown): ChangelogEntry[] {
  try {
    if (typeof markdown !== 'string' || !markdown.trim()) return []
    let text = markdown.replace(/\r\n/g, '\n')
    if (text.length > CHANGELOG_MAX_CHARS) text = text.slice(0, CHANGELOG_MAX_CHARS)
    const lines = text.split('\n')
    const entries: ChangelogEntry[] = []
    let cur: ChangelogEntry | null = null
    let curCat: ChangelogCategory | null = null
    // 围栏代码块里的 `##` 不是标题（如安装示例里的注释）：进围栏即暂停标题/条目识别，出围栏恢复。
    let inFence = false
    const pushCurrent = (): void => {
      if (!cur) return
      const hasAny = (CHANGELOG_ALL_CATEGORIES as readonly string[]).some(
        (c) => (cur as ChangelogEntry).sections[c as ChangelogCategory].length > 0,
      )
      // 空节忽略：六类全空的版本不收录（Unreleased 空节同样忽略）。
      if (!hasAny) return
      // 每类封顶（文件顺序前 N 条）。
      for (const c of CHANGELOG_ALL_CATEGORIES) {
        const list = cur.sections[c]
        if (list.length > CHANGELOG_MAX_BULLETS_PER_SECTION) {
          cur.sections[c] = list.slice(0, CHANGELOG_MAX_BULLETS_PER_SECTION)
        }
      }
      entries.push(cur)
    }
    for (const rawLine of lines) {
      const line = String(rawLine ?? '')
      // 围栏开关行本身不进条目。
      if (isFenceToggle(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      // 版本标题：`## ` 开头但非 `###`（三级是分类标题）。
      // 对抗复查收紧：`##` 后空格可选（`##[1.1.0]` 也是合法标题；此前漏收还会把下属条目
      // 错挂到上一个版本——归因污染比漏收更坏）。
      const versionTitle = matchVersionHeading(line)
      if (versionTitle !== null) {
        pushCurrent()
        cur = null
        curCat = null
        const title = versionTitle
        const { version, date, yanked } = extractVersionDateAndYanked(title)
        if (!version) continue
        cur = { version, date, yanked, sections: emptySections(), counts: emptyCounts() }
        continue
      }
      // 分类标题：`### Added` 等六类（英文大小写不敏感，亦收中文名，`###` 后空格同样可选），其余三级标题直接无视。
      const catTitle = matchCategoryHeading(line)
      if (catTitle !== null) {
        const cat = normalizeCategory(catTitle)
        curCat = cur && cat && isCategoryName(cat) ? cat : null
        continue
      }
      // 条目：`- `/`* `/`+ ` 开头。
      const bulletBody = matchBulletBody(line)
      if (bulletBody !== null && cur && curCat) {
        const item = truncateBullet(bulletBody)
        if (item) { cur.sections[curCat].push(item); try { if (cur.counts) cur.counts[curCat] += 1; } catch {} }
        continue
      }
      // 续行（#23 对抗复查收紧，此前太贪把顶格段落拼进上一条，直接改写条目原文）：
      // 只有缩进行才拼到上一条（markdown 换行惯例）；顶格文本视为段落忽略；
      // 任何 `#` 开头行永不进条目（此前裸 `###` 会被拼进上一条）。
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#') && /^\s/.test(line) && cur && curCat) {
        const list = cur.sections[curCat]
        if (list.length > 0) {
          const merged = truncateBullet(`${list[list.length - 1]} ${trimmed}`)
          if (merged) list[list.length - 1] = merged
        }
        continue
      }
      // 空行、顶格段落、标题残件：一律忽略（宁可丢字，不改写作者原文）。
    }
    pushCurrent()
    return entries.slice(0, CHANGELOG_MAX_ENTRIES)
  } catch {
    return []
  }
}

/** 该节是否有可见内容（六类任一非空）。 */
export function hasVisibleSections(entry: ChangelogEntry | null | undefined): boolean {
  if (!entry || typeof entry !== 'object') return false
  try {
    return CHANGELOG_ALL_CATEGORIES.some((c) => Array.isArray(entry.sections?.[c]) && entry.sections[c].length > 0)
  } catch {
    return false
  }
}

function compareReleaseSafe(a: string, b: string): -1 | 0 | 1 | null {
  try {
    return compareReleaseVersions(a, b)
  } catch {
    return null
  }
}

/**
 * 按区间筛选（文件顺序不变，最新在前）：
 * 只收发行版本号（Unreleased 与非法版本一律忽略）；
 * 只收 `(fromExclusive, toInclusive]`；
 * from 非法/缺省视为 -inf（全收 `<= to`）；to 非法/缺省回 []。
 *
 * 预发布节取舍（#23 对抗复查定稿）：区间内的预发布节一并收录（如 `(1.0.0, 1.1.0]` 含 `1.1.0-rc.1`）。
 * 通道门禁不在此做——`to` 本身由核心按通道滤过（stable 通道下远端永不为预发布），
 * 此处只管“两版之间有何内容”的人读完整性；面板永不拿它做安装分支。
 */
export function selectChangelogEntries(
  entries: unknown,
  fromExclusive: unknown,
  toInclusive: unknown,
): ChangelogEntry[] {
  try {
    if (!Array.isArray(entries) || entries.length === 0) return []
    const to = typeof toInclusive === 'string' ? toInclusive.trim() : ''
    if (!to || !validReleaseVersion(to)) return []
    const from = typeof fromExclusive === 'string' ? fromExclusive.trim() : ''
    const fromValid = from && validReleaseVersion(from) ? from : null
    const out: ChangelogEntry[] = []
    for (const e of entries as ChangelogEntry[]) {
      if (!e || typeof e !== 'object') continue
      const v = typeof (e as { version?: unknown }).version === 'string' ? String((e as { version: string }).version) : ''
      if (!v || isUnreleasedVersion(v) || !validReleaseVersion(v)) continue
      if (!hasVisibleSections(e)) continue
      const leTo = compareReleaseSafe(v, to)
      if (leTo === null || leTo > 0) continue
      if (fromValid) {
        const gtFrom = compareReleaseSafe(v, fromValid)
        if (gtFrom === null || gtFrom <= 0) continue
      }
      out.push(e)
    }
    return out
  } catch {
    return []
  }
}

/**
 * 更新区间便捷口：from 取运行版（ fallback 已装版），to 取远端版；
 * 任一缺失/非法即回 []（调用方渲染中性提示，不挡安装）。
 */
export function changelogForUpdate(
  entries: unknown,
  runningVersion: unknown,
  latestVersion: unknown,
  installedVersion?: unknown,
): ChangelogEntry[] {
  try {
    const to = typeof latestVersion === 'string' ? latestVersion.trim() : ''
    if (!to || !validReleaseVersion(to)) return []
    const run = typeof runningVersion === 'string' ? runningVersion.trim() : ''
    const inst = typeof installedVersion === 'string' ? installedVersion.trim() : ''
    const from = run && validReleaseVersion(run) ? run : inst && validReleaseVersion(inst) ? inst : ''
    if (!from) return []
    // 已是最新（to <= from）即无区间内容，回 [] 由渲染层给中性提示。
    const order = compareReleaseSafe(to, from)
    if (order === null || order <= 0) return []
    return selectChangelogEntries(entries, from, to)
  } catch {
    return []
  }
}

function escapeChangelogHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 计数元数据取值（缺省视为与 sections 等长，只记数字）。 */
export function countsOf(entry: ChangelogEntry | null | undefined): Record<ChangelogCategory, number> {
  try {
    const out: Record<ChangelogCategory, number> = { Added: 0, Fixed: 0, Changed: 0, Deprecated: 0, Removed: 0, Security: 0 };
    if (!entry || typeof entry !== 'object') return out;
    for (const c of CHANGELOG_ALL_CATEGORIES) {
      const n = (entry as { counts?: unknown }).counts as Record<string, unknown> | undefined;
      const v = n && typeof n[c] === 'number' && Number.isFinite(n[c] as number) ? Math.floor(n[c] as number) : null;
      if (v !== null && v >= 0) { out[c] = v; continue; }
      const list = (entry as { sections?: unknown }).sections as Record<string, unknown> | undefined;
      const arr = list ? list[c] : null;
      out[c] = Array.isArray(arr) ? arr.length : 0;
    }
    return out;
  } catch { return { Added: 0, Fixed: 0, Changed: 0, Deprecated: 0, Removed: 0, Security: 0 }; }
}

/** 超限小字（诚实截断，#66 入字典单语，lang 缺省 zh 零回归）：中文与旧文案一字不差，英文走字典。 */
export function truncatedNoteHTML(total: number, shown: number, lang?: AppLang | string | null): string {
  try {
    const l = normalizeLangTag(lang ?? 'zh')
    const m = Math.floor(total);
    const n = Math.floor(shown);
    const text = copyText('changelog.truncated.count', l, { m: String(m), n: String(n) })
    return '<div class="dsh-upd-changelog-count">' + escapeChangelogHtml(text) + '</div>';
  } catch { return ''; }
}

/** 撤回横幅（只看 to 版，纯展示，不挡安装，#66 入字典单语，lang 缺省 zh 零回归；中文与旧文案一字不差）。 */
export function yankedBannerHTML(version: unknown, lang?: AppLang | string | null): string {
  try {
    const l = normalizeLangTag(lang ?? 'zh')
    const v = typeof version === 'string' ? version.trim() : '';
    if (!v) return '';
    const text = copyText('changelog.yanked.banner', l, { version: v })
    return '<div class="dsh-upd-changelog-yanked" role="alert">' + escapeChangelogHtml(text) + '</div>';
  } catch { return ''; }
}

/** 单条目 HTML（含破坏标记徽标与前缀加粗，正文一字不动；#66 徽标与无障碍名入字典单语，lang 缺省 zh 零回归）。 */
export function renderChangelogItem(item: string, lang?: AppLang | string | null): string {
  try {
    const l = normalizeLangTag(lang ?? 'zh')
    const s = String(item !== null && item !== undefined ? item : '');
    if (!s) return '';
    const split = splitBreakingPrefix(s);
    if (!split) return '<li>' + escapeChangelogHtml(s) + '</li>';
    const head = escapeChangelogHtml(split.head);
    const prefix = escapeChangelogHtml(split.prefix);
    const rest = escapeChangelogHtml(split.rest);
    const badgeText = copyText('changelog.breaking.badge', l)
    const badgeAria = copyText('changelog.breaking.aria', l)
    const badge = '<span class="dsh-upd-breaking-badge" role="img" aria-label="' + escapeChangelogHtml(badgeAria) + '">' + escapeChangelogHtml(badgeText) + '</span> ';
    return '<li>' + head + badge + '<strong>' + prefix + '</strong>' + rest + '</li>';
  } catch { return ''; }
}

/** 单节 HTML（调用方保证已过滤 Unreleased 与空节，本函数再兜底一次；#66 按 lang 单语，缺省 zh 零回归）。 */
export function renderChangelogSection(entry: ChangelogEntry, lang?: AppLang | string | null): string {
  try {
    if (!entry || typeof entry !== 'object') return '';
    const version = String((entry as { version?: unknown }).version !== undefined && (entry as { version?: unknown }).version !== null ? String((entry as { version?: unknown }).version) : '').trim();
    if (!version || isUnreleasedVersion(version)) return '';
    if (!hasVisibleSections(entry)) return '';
    const l = normalizeLangTag(lang ?? 'zh')
    const dateRaw = (entry as { date?: unknown }).date;
    const date = typeof dateRaw === 'string' ? dateRaw : '';
    const yankedFlag = (entry as { yanked?: unknown }).yanked === true;
    const yankedSuffix = yankedFlag ? copyText('changelog.yanked.suffix', l) : '';
    // 日期包独立 span：默认主题无该 span 样式（继承标题样式，视觉一字不动）；
    // 档案卷皮肤把它收成灰色小字（原型 .logver .vh span）。
    const titleInner = date
      ? escapeChangelogHtml(version) + ' · ' + '<span class="dsh-upd-changelog-date">' + escapeChangelogHtml(date) + '</span>' + escapeChangelogHtml(yankedSuffix)
      : escapeChangelogHtml(version + yankedSuffix);
    const counts = countsOf(entry);
    const parts: string[] = [];
    parts.push('<div class="dsh-upd-changelog-version" data-version="' + escapeChangelogHtml(version) + '">');
    parts.push('<div class="dsh-upd-changelog-title">' + titleInner + '</div>');
    for (const cat of CHANGELOG_MUST_SHOW) {
      const items = Array.isArray((entry as { sections?: unknown }).sections ? (entry.sections as Record<string, unknown>)[cat] as unknown : null) ? (entry.sections as Record<string, string[]>)[cat] : [];
      if (!items || items.length === 0) continue;
      const label = changelogCategoryLabel(cat, l);
      parts.push('<div class="dsh-upd-changelog-cat" data-cat="' + cat + '">');
      parts.push('<div class="dsh-upd-changelog-catname">' + escapeChangelogHtml(label) + '</div>');
      const total = counts[cat];
      const shown = items.length;
      if (total > shown) { parts.push(truncatedNoteHTML(total, shown, l)); }
      parts.push('<ul>');
      for (const item of items) {
        if (!item) continue;
        const li = renderChangelogItem(item, l);
        if (li) parts.push(li);
      }
      parts.push('</ul>');
      if (cat === 'Security' && total > shown) {
        const restCount = total - shown;
        const sumText = copyText('changelog.security.summary', l, { n: String(restCount) })
        const noteText = copyText('changelog.security.note', l)
        parts.push('<details class="dsh-upd-changelog-security-more"><summary>' + escapeChangelogHtml(sumText) + '</summary><div class="dsh-upd-changelog-more-note">' + escapeChangelogHtml(noteText) + '</div></details>');
      }
      parts.push('</div>');
    }
    for (const cat of CHANGELOG_FOLDED) {
      const items = Array.isArray((entry as { sections?: unknown }).sections ? (entry.sections as Record<string, unknown>)[cat] as unknown : null) ? (entry.sections as Record<string, string[]>)[cat] : [];
      if (!items || items.length === 0) continue;
      const label = changelogFoldedLabel(cat, items.length, l);
      parts.push('<details class="dsh-upd-changelog-fold" data-cat="' + cat + '">');
      parts.push('<summary>' + escapeChangelogHtml(label) + '</summary>');
      const total = counts[cat];
      const shown = items.length;
      if (total > shown) { parts.push(truncatedNoteHTML(total, shown, l)); }
      parts.push('<ul>');
      for (const item of items) {
        if (!item) continue;
        const li = renderChangelogItem(item, l);
        if (li) parts.push(li);
      }
      parts.push('</ul></details>');
    }
    parts.push('</div>');
    return parts.join(String.fromCharCode(10));
  } catch {
    return '';
  }
}

/** 中性提示 HTML（缺日志、取不到、无区间内容时统一用它，不挡安装；#66 入字典单语，lang 缺省 zh 零回归）。 */
export function renderChangelogNeutral(lang?: AppLang | string | null): string {
  try {
    const l = normalizeLangTag(lang ?? 'zh')
    const text = copyText('changelog.neutral.line', l)
    return `<div class="dsh-upd-changelog-neutral">${escapeChangelogHtml(text)}</div>`
  } catch { return ''; }
}

/**
 * 区间渲染 HTML（纯函数）：
 * entries 非数组/空、无可见区间内容一律回中性提示；
 * Unreleased 与空节永不渲染；输出已转义，可直接拼进面板。
 */
export function renderChangelogHTML(
  entries: unknown,
  opts?: { from?: string | null; to?: string | null; lang?: AppLang | string | null },
): string {
  try {
    const l = normalizeLangTag((opts as { lang?: unknown } | undefined)?.lang ?? 'zh')
    if (!Array.isArray(entries) || entries.length === 0) return renderChangelogNeutral(l)
    const from = opts && typeof opts.from === 'string' ? opts.from : null
    const to = opts && typeof opts.to === 'string' ? opts.to : null
    let ranged: ChangelogEntry[]
    if (from !== null || to !== null) {
      ranged = selectChangelogEntries(entries, from, to)
    } else {
      ranged = (entries as ChangelogEntry[]).filter((e) => {
        try {
          const v = String((e as { version?: unknown }).version ?? '')
          return !!v && !isUnreleasedVersion(v) && hasVisibleSections(e)
        } catch {
          return false
        }
      })
    }
    if (ranged.length === 0) return renderChangelogNeutral(l)
    const blocks = ranged.map((e) => renderChangelogSection(e, l)).filter((s) => !!s)
    if (blocks.length === 0) return renderChangelogNeutral(l)
    return `<div class="dsh-upd-changelog">\n${blocks.join('\n')}\n</div>`
  } catch {
    try { const ll = normalizeLangTag((opts as { lang?: unknown } | undefined)?.lang ?? 'zh'); return renderChangelogNeutral(ll) } catch { return ''; }
  }
}
/** 校验诊断（一行一码，行号为原文件 1-based，诊断按行号排序）。 */
export interface ChangelogDiagnostic {
  line: number;
  code: string;
  hint: string;
}

export interface ChangelogValidation {
  ok: boolean;
  diagnostics: ChangelogDiagnostic[];
}

/** 校验提示文（与终裁码表一字对应，仅 CI/发布前用，运行时永不调用）。 */
export const CHANGELOG_VALIDATE_HINTS: Record<string, string> = {
  E_VERSION_TITLE: '该标题不是合法版本号，其下条目已被忽略，请改成 ## [x.y.z] 形态',
  E_CATEGORY: '未知分类，其下条目已被忽略；仅收 Added/Fixed/Changed/Deprecated/Removed/Security，亦收中文名（新增/修复/变更/弃用预告/移除/安全）',
  E_BULLET_ORPHAN: '该条目不在版本节与分类下，已被忽略',
  W_BREAKING_MAYBE: '疑似破坏标记误写（缺冒号/拼写接近/位置疑似放错），请检查是否想写 BREAKING:/不兼容:',
  W_YANKED: '该版本已被标记撤回（yanked），安装不受影响，继续前请确认',
  W_TRUNCATED: '该类共 M 条，仅显示前 N 条',
  W_TRUNCATED_FILE: '文件超 64K，仅校验前 64K',
  W_EMPTY: '未解析到任何版本节，面板将显示中性提示',
};

/** 疑似破坏误写（仅行首可疑，不报正文中间散文）。 */
export function isMaybeBreakingMisuse(bulletBody: unknown): boolean {
  try {
    if (typeof bulletBody !== 'string') return false;
    const t = stripBreakingDecorations(bulletBody);
    if (!t) return false;
    if (isBreakingChangelogItem(bulletBody)) return false;
    if (/^breaking\s*$/i.test(t)) return true;
    if (/^breaking\s+[^:：]/i.test(t)) return true;
    if (/^breaking[^:：\s\w]/i.test(t)) return true;
    if (/^不兼容\s*$/i.test(t)) return true;
    if (/^不兼容\s*[^:：]/i.test(t)) return true;
    if (/^(braking|breking|breakign|brekaing|braeking|breakingg)\b/i.test(t)) return true;
    if (/^break[^i:：\s]/i.test(t)) return true;
    return false;
  } catch { return false; }
}

/** 纯校验（零新增导入，与 parse 共享扫描仪，永不抛错，仅 CI/发布前用）。 */
export function validateChangelog(markdown: unknown): ChangelogValidation {
  try {
    if (typeof markdown !== 'string' || !markdown.trim()) {
      return { ok: true, diagnostics: [{ line: 1, code: 'W_EMPTY', hint: CHANGELOG_VALIDATE_HINTS.W_EMPTY }] };
    }
    let raw = String(markdown).replace(/\r\n/g, String.fromCharCode(10));
    let fileTruncated = false;
    if (raw.length > CHANGELOG_MAX_CHARS) { fileTruncated = true; raw = raw.slice(0, CHANGELOG_MAX_CHARS); }
    const lines = raw.split(String.fromCharCode(10));
    const diags: ChangelogDiagnostic[] = [];
    let inFence = false;
    let curValid = false;
    let curCat: string | null = null;
    let catLineByCat: Record<string, number> = {};
    let countByCat: Record<string, number> = {};
    let hasVisibleVersion = false;
    const flushCounts = function(): void {
      try {
        for (const k of Object.keys(countByCat)) {
          const n = countByCat[k];
          if (n > CHANGELOG_MAX_BULLETS_PER_SECTION) {
            const lineNo = catLineByCat[k] ? catLineByCat[k] : lines.length;
            const hint = '分类 ' + k + ' 共 ' + String(n) + ' 条，仅显示前 ' + String(CHANGELOG_MAX_BULLETS_PER_SECTION) + ' 条';
            diags.push({ line: lineNo, code: 'W_TRUNCATED', hint: hint });
          }
        }
      } catch { }
    };
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = String(lines[i] !== undefined && lines[i] !== null ? lines[i] : '');
      if (isFenceToggle(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const vTitle = matchVersionHeading(line);
      if (vTitle !== null) {
        flushCounts();
        catLineByCat = {};
        countByCat = {};
        curValid = false;
        curCat = null;
        const info = extractVersionDateAndYanked(vTitle);
        if (!info.version) {
          diags.push({ line: lineNo, code: 'E_VERSION_TITLE', hint: CHANGELOG_VALIDATE_HINTS.E_VERSION_TITLE });
          continue;
        }
        if (isUnreleasedVersion(info.version)) {
          curValid = false;
          continue;
        }
        curValid = true;
        hasVisibleVersion = true;
        if (info.yanked) { diags.push({ line: lineNo, code: 'W_YANKED', hint: CHANGELOG_VALIDATE_HINTS.W_YANKED }); }
        continue;
      }
      const cTitle = matchCategoryHeading(line);
      if (cTitle !== null) {
        const cat = normalizeCategory(cTitle);
        if (!cat) {
          curCat = null;
          diags.push({ line: lineNo, code: 'E_CATEGORY', hint: CHANGELOG_VALIDATE_HINTS.E_CATEGORY });
          continue;
        }
        if (!curValid) { curCat = null; continue; }
        curCat = cat;
        catLineByCat[cat] = lineNo;
        if (countByCat[cat] === undefined) countByCat[cat] = 0;
        continue;
      }
      const body = matchBulletBody(line);
      if (body !== null) {
        if (!curValid || !curCat) {
          diags.push({ line: lineNo, code: 'E_BULLET_ORPHAN', hint: CHANGELOG_VALIDATE_HINTS.E_BULLET_ORPHAN });
          continue;
        }
        countByCat[curCat] = (countByCat[curCat] ? countByCat[curCat] : 0) + 1;
        if (isMaybeBreakingMisuse(body)) {
          diags.push({ line: lineNo, code: 'W_BREAKING_MAYBE', hint: CHANGELOG_VALIDATE_HINTS.W_BREAKING_MAYBE });
        }
        continue;
      }
    }
    flushCounts();
    if (fileTruncated) { diags.push({ line: lines.length, code: 'W_TRUNCATED_FILE', hint: CHANGELOG_VALIDATE_HINTS.W_TRUNCATED_FILE }); }
    if (!hasVisibleVersion) {
      let anyVisible = false;
      try {
        const parsed = parseChangelog(markdown);
        for (const e of parsed) { if (e && !isUnreleasedVersion((e as { version?: unknown }).version) && hasVisibleSections(e)) { anyVisible = true; break; } }
      } catch { anyVisible = false; }
      if (!anyVisible) { diags.push({ line: lines.length, code: 'W_EMPTY', hint: CHANGELOG_VALIDATE_HINTS.W_EMPTY }); }
    }
    diags.sort(function(a, b) { return a.line - b.line; });
    let ok = true;
    for (const d of diags) { if (d.code.charAt(0) === 'E') { ok = false; break; } }
    return { ok: ok, diagnostics: diags };
  } catch {
    return { ok: false, diagnostics: [] };
  }
}

