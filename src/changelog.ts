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
 * 面板约定（Question 原文逐字落实）：
 * - `Added/Fixed/Changed` 必显；`Deprecated/Removed/Security` 透传折叠；
 * - `Unreleased` 与空节忽略；
 * - 缺日志中性提示，不挡安装、不写 blockedReason、不动快照六字段
 *   （本模块不碰快照，面板只增一节 HTML，安装门控只跟快照）；
 * - 已装版离线读、新版按需取 tarball 同名文件复用官方源 integrity
 *   （I/O 在 `src/changelog-io.ts` Node 侧，取不到回落中性提示）；
 * - 零依赖纯函数解析器（本文件零导入）。
 */

import { compareReleaseVersions, validReleaseVersion } from './service.js'

/** 包内日志文件名（包根，与 tarball 内同名文件同一名字）。 */
export const CHANGELOG_FILENAME = 'CHANGELOG.md'

/** 缺日志时的中性提示（不挡安装，安装按钮状态不变）。 */
export const CHANGELOG_NEUTRAL_HINT = '作者未提供更新说明'

/** 中性提示完整行（含“安装不受影响”，把“不挡安装”说成人话）。 */
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
export const CHANGELOG_MUST_SHOW: readonly ChangelogCategory[] = ['Added', 'Fixed', 'Changed']
/** 透传折叠三类（原样展示、不解析、不参与“有无新版”判断）。 */
export const CHANGELOG_FOLDED: readonly ChangelogCategory[] = ['Deprecated', 'Removed', 'Security']

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
}

function emptySections(): Record<ChangelogCategory, string[]> {
  return { Added: [], Fixed: [], Changed: [], Deprecated: [], Removed: [], Security: [] }
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
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      // 版本标题：`## ` 开头但非 `###`（三级是分类标题）。
      // 对抗复查收紧：`##` 后空格可选（`##[1.1.0]` 也是合法标题；此前漏收还会把下属条目
      // 错挂到上一个版本——归因污染比漏收更坏）。
      const versionHeading = line.match(/^##(?!#)\s*(.+?)\s*$/)
      if (versionHeading) {
        pushCurrent()
        cur = null
        curCat = null
        const title = (versionHeading[1] ?? '').trim()
        const { version, date, yanked } = extractVersionDateAndYanked(title)
        if (!version) continue
        cur = { version, date, yanked, sections: emptySections() }
        continue
      }
      // 分类标题：`### Added` 等六类（大小写不敏感，`##` 后空格同样可选），其余三级标题直接无视。
      const catMatch = line.match(/^###\s*(.+?)\s*$/)
      if (catMatch) {
        const cat = normalizeCategory(catMatch[1] ?? '')
        curCat = cur && cat && isCategoryName(cat) ? cat : null
        continue
      }
      // 条目：`- `/`* `/`+ ` 开头。
      const bullet = line.match(/^\s*[-*+]\s+(.+?)\s*$/)
      if (bullet && cur && curCat) {
        const item = truncateBullet(bullet[1] ?? '')
        if (item) cur.sections[curCat].push(item)
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

/** 单节 HTML（调用方保证已过滤 Unreleased 与空节，本函数再兜底一次）。 */
export function renderChangelogSection(entry: ChangelogEntry): string {
  try {
    if (!entry || typeof entry !== 'object') return ''
    const version = String((entry as { version?: unknown }).version ?? '').trim()
    if (!version || isUnreleasedVersion(version)) return ''
    if (!hasVisibleSections(entry)) return ''
    const date = typeof (entry as { date?: unknown }).date === 'string' ? String((entry as { date: string }).date) : ''
    const yankedSuffix = (entry as { yanked?: unknown }).yanked === true ? ' · 已撤回' : ''
    const title = (date ? `${version} · ${date}` : version) + yankedSuffix
    const parts: string[] = []
    parts.push(`<div class="dsh-upd-changelog-version" data-version="${escapeChangelogHtml(version)}">`)
    parts.push(`<div class="dsh-upd-changelog-title">${escapeChangelogHtml(title)}</div>`)
    for (const cat of CHANGELOG_MUST_SHOW) {
      const items = Array.isArray(entry.sections?.[cat]) ? entry.sections[cat] : []
      if (items.length === 0) continue
      const label = `${cat} · ${CHANGELOG_CATEGORY_ZH[cat]}`
      parts.push(`<div class="dsh-upd-changelog-cat" data-cat="${cat}">`)
      parts.push(`<div class="dsh-upd-changelog-catname">${escapeChangelogHtml(label)}</div>`)
      parts.push('<ul>')
      for (const item of items) {
        if (!item) continue
        parts.push(`<li>${escapeChangelogHtml(item)}</li>`)
      }
      parts.push('</ul></div>')
    }
    for (const cat of CHANGELOG_FOLDED) {
      const items = Array.isArray(entry.sections?.[cat]) ? entry.sections[cat] : []
      if (items.length === 0) continue
      const label = `${cat} · ${CHANGELOG_CATEGORY_ZH[cat]}（${items.length}）`
      parts.push(`<details class="dsh-upd-changelog-fold" data-cat="${cat}">`)
      parts.push(`<summary>${escapeChangelogHtml(label)}</summary>`)
      parts.push('<ul>')
      for (const item of items) {
        if (!item) continue
        parts.push(`<li>${escapeChangelogHtml(item)}</li>`)
      }
      parts.push('</ul></details>')
    }
    parts.push('</div>')
    return parts.join('\n')
  } catch {
    return ''
  }
}

/** 中性提示 HTML（缺日志、取不到、无区间内容时统一用它，不挡安装）。 */
export function renderChangelogNeutral(): string {
  return `<div class="dsh-upd-changelog-neutral">${escapeChangelogHtml(CHANGELOG_NEUTRAL_LINE)}</div>`
}

/**
 * 区间渲染 HTML（纯函数）：
 * entries 非数组/空、无可见区间内容一律回中性提示；
 * Unreleased 与空节永不渲染；输出已转义，可直接拼进面板。
 */
export function renderChangelogHTML(
  entries: unknown,
  opts?: { from?: string | null; to?: string | null },
): string {
  try {
    if (!Array.isArray(entries) || entries.length === 0) return renderChangelogNeutral()
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
    if (ranged.length === 0) return renderChangelogNeutral()
    const blocks = ranged.map((e) => renderChangelogSection(e)).filter((s) => !!s)
    if (blocks.length === 0) return renderChangelogNeutral()
    return `<div class="dsh-upd-changelog">\n${blocks.join('\n')}\n</div>`
  } catch {
    return renderChangelogNeutral()
  }
}
