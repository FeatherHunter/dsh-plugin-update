/**
 * src/core/changelog/parse.ts —— 包内 CHANGELOG.md 的纯解析（#23，承接 #11 取证）；
 * 自旧 src/changelog.ts 拆出，渲染在 render-model.ts、校验在 validator.ts、Node 侧读写 io.ts。
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
 * - 缺日志中性提示，不挡安装、不写 blockedReason、不动快照字段
 *   （本模块不碰快照，面板只增一节 HTML，安装门控只跟快照）；
 * - 已装版离线读、新版按需取 tarball 同名文件复用官方源 integrity
 *   （I/O 在 core/changelog/io.ts Node 侧，取不到回落中性提示）；
 * - 纯函数解析器（仅复用版本语义，不碰 Node 专属；新增 validate 与策略函数零新增导入）。
 * - 截断数值不动（100 节/每类 200 条/单条 500 字/全文 64K），解析附计数元数据只记数字；
 *   超限类标计数小字，Security 超限进内折叠；BREAKING 前缀识别 + 行首徽标；yanked 横幅只看 to 版。
 */

import { compareReleaseVersions, validReleaseVersion } from '../service.js'
import { normalizeLangTag, type AppLang } from '../../shared/lang.js'

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
/** 单条上限（字符）：超限在尾部截断并加省略号（含换行，多行条目按行累加）。 */
export const CHANGELOG_MAX_BULLET_CHARS = 500
/**
 * 条目内嵌套层级上限（渲染与解析共用同一折算：2 空格/制表符 = 1 级）。
 * 3 级足够画真实日志（子条目 + 子条目的续行），再深就贴边了——封顶也把递归深度钉死在常数上。
 */
export const CHANGELOG_MAX_ENTRY_DEPTH = 3

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

/**
 * 作者自定义小节（非六类的 `###` 标题、以及版本节下没有分类标题的裸条目）。
 * `title` 保留作者原文（`''` = 无标题的隐式小节）；`count` 是截断前条数（与六类 counts 同义）。
 * 这块是**渲染层**的兜底：解析层不猜分类（归因污染比漏收更坏），只把作者的标题原样带出来。
 */
export interface ChangelogOtherSection {
  title: string
  items: string[]
  count?: number
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
  /** 非六类小节（文档顺序；缺省/空数组 = 该版本只有六类内容，旧调用方零感知）。 */
  otherSections?: ChangelogOtherSection[]
}

/**
 * 解析期的“丢字账本”（渲染层据此把截断写在面板上，不再静默丢）。
 * 三个上限各自计数：`chars` = 文件超过 64 KiB 被切（附 tailVersions = 被切掉那头还有几个版本标题）；
 * `entries` = 超过 100 个版本节被切；`sections` = 某类/某小节超过 200 条被切（附 items = 被切条数）；
 * `items` = 单条超过 500 字被截（渲染层已在条目尾部给 `…`，此处只报数）。
 */
export interface ChangelogTruncation {
  chars: boolean
  tailVersions: number
  entries: number
  sections: number
  sectionItems: number
  items: number
}

/** 解析结果（entries 是冻结公开形状；truncation 是 0.16.0 新增的附加通道）。 */
export interface ChangelogParseReport {
  entries: ChangelogEntry[]
  truncation: ChangelogTruncation
}

/** 六类名的**无歧义**同义词（changesets / semantic-release / 中文写法）。
 *  只收「换个说法但指的是同一类」的词；`Patch Changes`、`Chores`、`Documentation` 这类
 *  语义含混的一律不猜，按作者原文当自定义小节展示（归因污染比漏收更坏）。 */
export const CHANGELOG_CATEGORY_ALIASES: Record<string, ChangelogCategory> = {
  'bug fixes': 'Fixed',
  fixes: 'Fixed',
  fix: 'Fixed',
  'bug fix': 'Fixed',
  features: 'Added',
  feature: 'Added',
  feat: 'Added',
  'security fixes': 'Security',
  'security fix': 'Security',
  deprecations: 'Deprecated',
  removals: 'Removed',
  修复: 'Fixed',
  新增: 'Added',
  特性: 'Added',
  变更: 'Changed',
  改动: 'Changed',
  移除: 'Removed',
  弃用: 'Deprecated',
  安全: 'Security',
}

function emptySections(): Record<ChangelogCategory, string[]> {
  return { Added: [], Fixed: [], Changed: [], Deprecated: [], Removed: [], Security: [] }
}

function emptyCounts(): Record<ChangelogCategory, number> {
  return { Added: 0, Fixed: 0, Changed: 0, Deprecated: 0, Removed: 0, Security: 0 }
}

export function isCategoryName(v: string): v is ChangelogCategory {
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
  // 无歧义同义词（`Bug Fixes`、`Features`、`修复`…）：changesets / semantic-release 模板大量在用。
  // 见 CHANGELOG_CATEGORY_ALIASES 的收词口径——含混的一律不收，宁可当自定义小节原样显示。
  const alias = CHANGELOG_CATEGORY_ALIASES[t]
  if (alias) return alias
  // 中文名（与 CHANGELOG_CATEGORY_ZH 同一表，不另起第二映射；精确匹配，不做子串，
  // 免得「新增功能」这类标题被误收到 Added——归因污染比漏收更坏）。
  for (const k of CHANGELOG_ALL_CATEGORIES) {
    if (t === CHANGELOG_CATEGORY_ZH[k]) return k
  }
  return null
}

/** 中英并排/并列写法（`Fixed / 修复`、`Security | 安全`）：各段归一到同一类才算数，否则交回自定义小节。 */
export function normalizeCategoryMulti(raw: string): ChangelogCategory | null {
  const t = String(raw || '').trim()
  if (!t) return null
  const parts = t.split(/[/|·、,，;；+]/).map((s) => s.trim()).filter((s) => !!s)
  if (parts.length <= 1) return normalizeCategory(t)
  let acc: ChangelogCategory | null = null
  for (const part of parts) {
    const cat = normalizeCategory(part)
    if (!cat) return null
    if (acc === null) acc = cat
    else if (acc !== cat) return null
  }
  return acc
}

/** 是否 Unreleased（大小写不敏感，前后空白忽略）。 */
export function isUnreleasedVersion(v: unknown): boolean {
  return typeof v === 'string' && v.trim().toLowerCase() === 'unreleased'
}

export function extractVersionDateAndYanked(title: string): { version: string | null; date: string | null; yanked: boolean } {
  const t = String(title || '').trim()
  if (!t) return { version: null, date: null, yanked: false }
  const yanked = /\[YANKED\]/i.test(t)
  if (/unreleased/i.test(t)) return { version: 'Unreleased', date: null, yanked }
  // 对抗复查收紧：版本号在标题任意位置出现即收（`## Version 1.1.0`、无空格 `##[1.1.0]`、
  // 可链接标题 `## [1.1.0](url) - date` 均可；此前只看首 token/首括号，真实日志大量漏收）。
  // 取第一个命中的版本号形态（0.16.0 起两段也算：`## 1.0` 在真实日志里 79 处、此前整节丢字）；
  // 日期用连字符，不会误命中版本号的点分形态。
  const vm = t.match(RE_VERSION_TOKEN)
  if (!vm) return { version: null, date: null, yanked: false }
  const dm = t.match(/(\d{4}-\d{2}-\d{2})/)
  return { version: vm[1], date: dm ? dm[1] : null, yanked }
}

/** 单行文本：折叠空白并按预算截断（单行场景口径自 #23 起不变）。 */
export function truncateBullet(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (t.length <= CHANGELOG_MAX_BULLET_CHARS) return t
  return `${t.slice(0, CHANGELOG_MAX_BULLET_CHARS - 1)}…`
}

/** 行首缩进折算的嵌套层级（2 空格/制表符 = 1 级，封顶 CHANGELOG_MAX_ENTRY_DEPTH）。 */
export function indentLevel(line: string): number {
  const raw = (String(line || '').match(/^[ \t]*/) || [''])[0]
  let n = 0
  for (const ch of raw) n += ch === '\t' ? 2 : 1
  return Math.min(CHANGELOG_MAX_ENTRY_DEPTH, Math.floor(n / 2))
}

/**
 * 有序条目 `1. `/`1) `（`RE_BULLET` 只管 `-*+`，这里另认一支）。
 * 只在**子条目**位置上被录用：顶格编号行按既有口径仍当段落忽略，免得正文里的编号行变成条目。
 */
function matchOrderedBody(line: string): string | null {
  const m = String(line || '').match(/^\s*\d{1,9}[.)]\s+(.+?)\s*$/)
  return m ? String(m[1] !== undefined && m[1] !== null ? m[1] : '') : null
}

/**
 * 结构感知截断：按行累加，装不下的行**不再硬塞碎屑**，而是给已收的正文补 `…`（截断看得见）。
 * 与旧的「拼成一行再切」不同，这里**保留换行**——块级渲染（嵌套列表/引用块/围栏代码块）
 * 全靠行边界，压成一行就再也分不出来了。
 */
function truncateEntryLines(lines: readonly string[], ledger?: ChangelogTruncation): string {
  const out: string[] = []
  let truncated = false
  for (const raw of lines) {
    const line = String(raw === null || raw === undefined ? '' : raw).replace(/[ \t]+$/, '')
    if (!line) continue
    const next = out.length > 0 ? out.join('\n') + '\n' + line : line
    if (next.length <= CHANGELOG_MAX_BULLET_CHARS) { out.push(line); continue }
    truncated = true
    break
  }
  const text = out.join('\n')
  if (!truncated) return text
  if (ledger) ledger.items += 1
  if (text.length < CHANGELOG_MAX_BULLET_CHARS) return text + '…'
  return text.slice(0, CHANGELOG_MAX_BULLET_CHARS - 1) + '…'
}

/** 缓冲区最后一行是不是列表项/围栏（空行分段只对段落有意义：段落之间分段，列表项之间不断）。 */
function bufEndsWithItem(lines: readonly string[]): boolean {
  const last = Array.isArray(lines) && lines.length > 0 ? String(lines[lines.length - 1] || '') : ''
  if (!last) return false
  if (RE_FENCE_TOGGLE.test(last)) return true
  return /^[ \t]*(?:[-*+]|\d{1,9}[.)])\s+/.test(last)
}

/** 嵌套子条目的规范写法：保留原标记（`-`/`*`/`+`/`1.`）与层级缩进（每级 2 空格）。 */
function canonicalNestedItem(line: string, level: number, body: string): string {
  const m = String(line || '').match(/^[ \t]*(?:([-*+])|(\d{1,9}[.)]))\s+/)
  const marker = m && m[2] ? m[2] : (m && m[1] ? m[1] : '-')
  return '  '.repeat(Math.max(1, level)) + marker + ' ' + String(body || '').replace(/\s+/g, ' ').trim()
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

/** 版本号 token（两段起；`1.0`、`1.2.3`、`v2.0-rc.1` 都算）。三段形态之外的 `## 1.0` 是真实日志
 *  里 79 处「整节丢字」的根源（#116 取样），0.16.0 起按版本节收。 */
const RE_VERSION_TOKEN = /(\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)/;

/**
 * 标题**除版本号外只剩装饰**（`## 1.0`、`## [1.2] - 2026-10-14`、`## v0.14`）。
 * 只认「纯版本标题」是为了不把 `### 修复 1.2 的 bug` 这种带正文的小节标题误升级成版本节。
 */
function isPlainVersionTitle(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (!/(?:^|[^\d.])v?\d+\.\d+(?![\d.])/.test(t)) return false
  const core = t
    .replace(/\[YANKED\]/gi, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/[\[\]()（）【】]/g, ' ')
    .replace(/^[\s#>*_\-\u2014\u2013:：|]+/, '')
    .replace(/[\s#>*_\-\u2014\u2013:：|]+$/, '')
    .trim()
  return /^v?\d+\.\d+$/.test(core)
}

/**
 * 像版本标题但**取不出**版本号：`## 1`、`## 2026-10-14`（连点都没有的号）。
 * 这种标题下的内容归属不了任何版本，必须诚实报 E_VERSION_TITLE，别装作没事。
 */
export function isVersionIshWithoutNumber(text: unknown): boolean {
  const t = String(text !== null && text !== undefined ? text : '').trim()
  if (!t) return false
  if (extractVersionDateAndYanked(t).version) return false
  return /^\s*v?\d+\s*(?:$|[\u2014\u2013\-(（])/.test(t)
}

/** 该行能不能当 setext 标题的**标题行**（下一行是 `===`／`---` 下划线）。 */
function isSetextTextCandidate(line: string): boolean {
  const t = String(line === null || line === undefined ? '' : line)
  if (!t.trim()) return false
  if (/^[ \t]/.test(t)) return false
  if (/^\s{0,3}#{1,6}\s/.test(t)) return false
  if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(t)) return false
  if (/^\s*>/.test(t)) return false
  if (/^\s*\|/.test(t)) return false
  if (isFenceToggle(t)) return false
  return true
}

/**
 * setext 下划线标题（`标题` + `===`／`---`）转成 ATX 形态再走同一套判据（#116 野外 2 份文件 47 处）。
 * **保持行数不变**——下划线那行清空而不是删掉，validate 的行号才仍然对得上原文件。
 */
export function normalizeSetextHeadings(lines: readonly string[]): string[] {
  const out = lines.map((l) => String(l === null || l === undefined ? '' : l))
  for (let i = 0; i + 1 < out.length; i++) {
    const m = out[i + 1].match(/^ {0,3}(={3,}|-{3,})\s*$/)
    if (!m || !isSetextTextCandidate(out[i])) continue
    out[i] = (m[1].charAt(0) === '=' ? '# ' : '## ') + out[i].trim()
    out[i + 1] = ''
  }
  return out
}

export function matchVersionHeading(line: unknown): string | null {
  try {
    const s = String(line !== null && line !== undefined ? line : '');
    const m = s.match(RE_VERSION_HEADING);
    if (!m) return null;
    return String(m[1] !== undefined && m[1] !== null ? m[1] : '').trim();
  } catch { return null; }
}

/** 任意层级标题（1–6 级；`#` 后空格可选，兼容 `##[1.1.0]` 这种真实写法）。 */
export const RE_ANY_HEADING = /^\s{0,3}(#{1,6})\s*(.+?)\s*$/

/**
 * 标题文本是否**看起来是版本节**：含三段版本号（可带预发布后缀）、纯两段版本标题，或 `Unreleased`。
 * 这个判据是「不再产幻影版本」的闸门：`# Changelog`、`## 关于本包`、`## License` 都过不去，
 * 不会被当成版本节去挂条目；`### 修复 1.2 的 bug` 也过不去（带正文的两段号不算版本标题）。
 */
export function looksLikeVersionHeading(text: unknown): boolean {
  const t = String(text !== null && text !== undefined ? text : '').trim()
  if (!t) return false
  if (RE_UNRELEASED.test(t)) return true
  if (RE_VERSION_NUM.test(t)) return true
  return isPlainVersionTitle(t)
}

/** 拆任意层级标题（认不出回 null）。 */
export function matchAnyHeading(line: unknown): { level: number; text: string } | null {
  try {
    const s = String(line !== null && line !== undefined ? line : '')
    const m = s.match(RE_ANY_HEADING)
    if (!m) return null
    return { level: (m[1] || '').length, text: String(m[2] !== undefined && m[2] !== null ? m[2] : '').trim() }
  } catch { return null }
}

/** 任意层级里的**版本节**标题（1–4 级 + looksLikeVersionHeading；5–6 级当小节标题）。 */
export function matchVersionHeadingAny(line: unknown): string | null {
  const h = matchAnyHeading(line)
  if (!h || h.level > 4) return null
  return looksLikeVersionHeading(h.text) ? h.text : null
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

/** 条目正文的目标小节：六类之一，或作者自定义小节。 */
type SectionDest = { cat: ChangelogCategory } | { other: ChangelogOtherSection }
/** 正在攒的一条条目正文（多行文本 + 它要落进哪个小节）。 */
type EntryBuf = { lines: string[]; dest: SectionDest }

/** 追加一个自定义小节；紧邻的空标题隐式小节（还没收到条目）直接改名复用，免得留下两个空块。 */
function ensureOther(cur: ChangelogEntry, title: string): ChangelogOtherSection {
  const list = cur.otherSections ?? (cur.otherSections = [])
  const last = list[list.length - 1]
  if (title && last && last.title === '' && last.items.length === 0) {
    last.title = title.slice(0, 120)
    return last
  }
  const sec: ChangelogOtherSection = { title: title.slice(0, 120), items: [], count: 0 }
  list.push(sec)
  return sec
}

/** 被切掉的尾巴里还有几个版本节标题（只说数，不解析内容）。 */
function countVersionHeadings(tail: string): number {
  let n = 0
  for (const line of String(tail || '').split('\n')) {
    if (matchVersionHeadingAny(line) !== null) n += 1
  }
  return n
}

/**
 * 解析 CHANGELOG Markdown（纯函数，永不抛错）：
 * 非字符串/空串回 []；超长截断后解析（切掉多少记进 truncation，不再静默）；
 * 版本节 = 1–4 级标题且文本像版本号（没有版本号的标题当**小节标题**，其内容不再丢）；
 * 六类之外的 `###` 与「版本节下没有分类标题的裸条目」进 otherSections（保留作者标题，不猜分类）；
 * 空节忽略；Unreleased 保留（渲染与区间时忽略）。
 */
export function parseChangelogReport(markdown: unknown): ChangelogParseReport {
  const ledger: ChangelogTruncation = { chars: false, tailVersions: 0, entries: 0, sections: 0, sectionItems: 0, items: 0 }
  try {
    if (typeof markdown !== 'string' || !markdown.trim()) return { entries: [], truncation: ledger }
    let text = markdown.replace(/\r\n/g, '\n')
    if (text.length > CHANGELOG_MAX_CHARS) {
      ledger.chars = true
      ledger.tailVersions = countVersionHeadings(text.slice(CHANGELOG_MAX_CHARS))
      text = text.slice(0, CHANGELOG_MAX_CHARS)
    }
    const lines = normalizeSetextHeadings(text.split('\n'))
    const entries: ChangelogEntry[] = []
    let cur: ChangelogEntry | null = null
    // 当前小节：六类之一，或作者自定义小节（含 title='' 的隐式小节）。
    let bucket: { cat: ChangelogCategory } | { other: ChangelogOtherSection } | null = null
    // 围栏代码块里的 `##` 不是标题（如安装示例里的注释）：进围栏即暂停标题/条目识别，出围栏恢复。
    let inFence = false
    // 当前正在攒的条目正文（多行：第一行是条目正文，后续行是嵌套子条目/续行/引用/代码块）。
    // 攒到下一个条目、下一个标题或文件结尾才落进目标小节 —— 这样块级结构才留得住。
    let buf: EntryBuf | null = null
    // 闭包写、外层读的变量在 TS 里会被收窄成 null（这里显式取一次，别让类型窄化骗过编译器）。
    const bufNow = (): EntryBuf | null => buf
    // 非 null 表示「当前围栏属于这条条目」：内容收进它，渲染层画 <pre><code>（此前整段静默丢字）。
    let fenceTo: string[] | null = null
    // 开栏那一行的缩进：代码内容按同样宽度去缩进，免得面板里整体右移一截。
    let fenceIndent = 0
    // 空行只记边界（块级渲染靠它分段），不落字。
    let pendingBlank = false
    const destOf = (): { cat: ChangelogCategory } | { other: ChangelogOtherSection } | null => {
      if (!bucket) return null
      return 'cat' in bucket ? { cat: bucket.cat } : { other: bucket.other }
    }
    // 版本节下没有分类标题就出现的条目：开一个无标题隐式小节接收，绝不丢字也不猜分类。
    const ensureDest = (): { cat: ChangelogCategory } | { other: ChangelogOtherSection } | null => {
      const d = destOf()
      if (d) return d
      if (!cur) return null
      const other = ensureOther(cur as ChangelogEntry, '')
      bucket = { other }
      return { other }
    }
    const flushBuf = (): void => {
      const pending = buf
      buf = null
      pendingBlank = false
      if (!pending || !cur) return
      const text = truncateEntryLines(pending.lines, ledger)
      if (!text) return
      const c = cur as ChangelogEntry
      if ('cat' in pending.dest) {
        c.sections[pending.dest.cat].push(text)
        try { if (c.counts) c.counts[pending.dest.cat] += 1 } catch {}
      } else {
        pending.dest.other.items.push(text)
        pending.dest.other.count = (pending.dest.other.count ?? 0) + 1
      }
    }
    const openBuf = (first: string, dest: { cat: ChangelogCategory } | { other: ChangelogOtherSection }): void => {
      buf = { lines: [first], dest }
    }
    const pushCurrent = (): void => {
      flushBuf()
      if (!cur) return
      const e = cur as ChangelogEntry
      const hasAny = (CHANGELOG_ALL_CATEGORIES as readonly string[]).some((c) => e.sections[c as ChangelogCategory].length > 0)
        || (e.otherSections ?? []).some((s) => s.items.length > 0)
      // 空节忽略：六类与自定义小节全空的版本不收录（Unreleased 空节同样忽略）。
      if (!hasAny) return
      // 每类封顶（文件顺序前 N 条），切掉的条数记账（渲染层把「共 N 条，只显示前 M 条」写在面板上）。
      for (const c of CHANGELOG_ALL_CATEGORIES) {
        const list = e.sections[c]
        if (list.length > CHANGELOG_MAX_BULLETS_PER_SECTION) {
          ledger.sections += 1
          ledger.sectionItems += list.length - CHANGELOG_MAX_BULLETS_PER_SECTION
          e.sections[c] = list.slice(0, CHANGELOG_MAX_BULLETS_PER_SECTION)
        }
      }
      for (const s of e.otherSections ?? []) {
        if (s.items.length > CHANGELOG_MAX_BULLETS_PER_SECTION) {
          ledger.sections += 1
          ledger.sectionItems += s.items.length - CHANGELOG_MAX_BULLETS_PER_SECTION
          s.items = s.items.slice(0, CHANGELOG_MAX_BULLETS_PER_SECTION)
        }
      }
      entries.push(e)
    }
    for (const rawLine of lines) {
      const line = String(rawLine ?? '')
      // 围栏：开关行自己不进条目；**缩进**围栏（属于上一条的用法示例）内容挂到当前条目下，
      // 渲染层画 <pre><code>；顶格围栏在版本节内同样收（它也是作者的原文），版本节之外仍忽略。
      if (isFenceToggle(line)) {
        if (inFence) {
          inFence = false
          if (fenceTo) { fenceTo.push('```'); fenceTo = null }
          continue
        }
        inFence = true
        const lead = ((line.match(/^[ \t]*/) || [''])[0] || '').length
        fenceIndent = lead
        const b0 = bufNow()
        if (lead > 0 && b0) {
          fenceTo = b0.lines
          fenceTo.push('```' + line.replace(/^[ \t]*(?:`{3,}|~{3,})\s*/, '').trim())
          continue
        }
        const dest = ensureDest()
        flushBuf()
        if (dest) {
          openBuf('```' + line.replace(/^[ \t]*(?:`{3,}|~{3,})\s*/, '').trim(), dest)
          const b1 = bufNow()
          fenceTo = b1 ? b1.lines : null
        } else {
          fenceTo = null
        }
        continue
      }
      if (inFence) {
        if (fenceTo) {
          const lead = ((line.match(/^[ \t]*/) || [''])[0] || '').length
          fenceTo.push(line.slice(Math.min(fenceIndent, lead)).replace(/[ \t]+$/, ''))
        }
        continue
      }
      // 标题：1–4 级且像版本号 → 新版本节；不像版本号的标题 → 小节标题（六类走分类，其余保留原文标题）。
      const head = matchAnyHeading(line)
      if (head) {
        const vTitle = head.level <= 4 && looksLikeVersionHeading(head.text) ? head.text : null
        if (vTitle !== null) {
          pushCurrent()
          cur = null
          bucket = null
          const { version, date, yanked } = extractVersionDateAndYanked(vTitle)
          if (!version) continue
          cur = { version, date, yanked, sections: emptySections(), counts: emptyCounts() }
          continue
        }
        // `## 1`（连点都没有的号）这类像版本、却取不出号；`## 1.0` 已走上一条按版本节收（0.16.0）。
        // 取不出号的标题下内容归属不了任何版本，结束当前节后忽略——但 validate 会诚实报 E_VERSION_TITLE。
        if (isVersionIshWithoutNumber(head.text)) {
          if (cur) {
            pushCurrent()
            cur = null
            bucket = null
          }
          continue
        }
        if (cur) {
          flushBuf()
          const cat = normalizeCategoryMulti(head.text)
          if (cat && isCategoryName(cat)) bucket = { cat }
          else bucket = { other: ensureOther(cur as ChangelogEntry, head.text) }
          continue
        }
        // 版本节之前/之外的标题（文件头的 `# Changelog`、`## 体例说明`、`## License`）：不是发行内容，忽略。
        continue
      }
      // 条目：`- `/`* `/`+ ` 开头（缩进 ≥2 空格的算上一条的**子条目**，不再拍平成同级兄弟）；
      // 子条目位置上的 `1. ` 走有序列表；顶格编号行仍不当条目（正文里的编号行很常见），按段落收字。
      const bulletBody = matchBulletBody(line)
      const orderedBody = bulletBody === null ? matchOrderedBody(line) : null
      const body = bulletBody !== null ? bulletBody : orderedBody
      if (body !== null) {
        const level = indentLevel(line)
        const b = bufNow()
        if (level > 0 && b && !(pendingBlank && !bufEndsWithItem(b.lines))) {
          b.lines.push(canonicalNestedItem(line, level, body))
          pendingBlank = false
          continue
        }
        if (bulletBody !== null) {
          const b2 = bufNow()
          if (pendingBlank && b2 && !bufEndsWithItem(b2.lines)) flushBuf()
          flushBuf()
          const dest = ensureDest()
          if (body.replace(/\s+/g, ' ').trim().length > CHANGELOG_MAX_BULLET_CHARS) ledger.items += 1
          const item = truncateBullet(body)
          if (dest && item) openBuf(item, dest)
          continue
        }
        // 顶格有序行：当段落正文收（不当条目），留字不猜结构。
      }
      const trimmed = line.trim()
      if (!trimmed) { pendingBlank = true; continue }
      // 任何 `#` 开头行永不进条目（标题分支没认出来的标题残件，如 `####`）。
      if (trimmed.startsWith('#')) continue
      // 版本节内的其余文本（顶格段落、引用块、缩进续行）：一律按原文收进当前小节，不再丢字。
      // 版本节之外（文件头的体例说明等）仍忽略——那不是某个版本的内容。
      if (cur) {
        const dest = ensureDest()
        if (!dest) continue
        const bp = bufNow()
        // 顶格块（段落/引用）与上一条之间隔了空行 ⇒ 另起一条：Markdown 里空行就是段落边界，
        // 硬并进上一条会把「围栏代码块后面的顶格引用」粘成同一条（0.16.0 块级口径）。
        // 缩进行（含子条目续行、缩进引用）照旧并进当前条目——它属于那条。
        if (bp && pendingBlank && !/^[ \t]/.test(line)) flushBuf()
        // 引用行与缩进续行按原文层级规范化保留（块级渲染靠它分层），顶格段落原样收字。
        const isQuote = trimmed === '>' || trimmed.startsWith('> ')
        const text = isQuote
          ? '> ' + trimmed.replace(/^>\s?/, '')
          : /^[ \t]/.test(line)
            ? '  '.repeat(Math.max(1, indentLevel(line))) + trimmed
            : trimmed.replace(/[ \t]+$/, '')
        const bp2 = bufNow()
        if (bp2) bp2.lines.push(text)
        else openBuf(text, dest)
        pendingBlank = false
      }
    }
    pushCurrent()
    if (entries.length > CHANGELOG_MAX_ENTRIES) {
      ledger.entries = entries.length - CHANGELOG_MAX_ENTRIES
      return { entries: entries.slice(0, CHANGELOG_MAX_ENTRIES), truncation: ledger }
    }
    return { entries, truncation: ledger }
  } catch {
    return { entries: [], truncation: ledger }
  }
}

/** 兼容口：只要条目数组（既有调用方与测试用的就是它）。 */
export function parseChangelog(markdown: unknown): ChangelogEntry[] {
  return parseChangelogReport(markdown).entries
}

/**
 * 「有新版，但更新说明一片空白」到底为什么（#213，来源 docs/research/20261018-日志必要性对抗审查.md §4.5）：
 * `ok` 解析出了结构；`empty` 包里那个文件在、但是空的；`missing` 包里根本没这个文件；
 * `fetch-failed` 取数这步就没成（网络/超时/integrity 不符/JSON 坏）；`parse-degraded` 有内容但解析不出结构；
 * `cache-hit` 本次只是回宿主缓存（内容态由缓存里记着的那次结论给出，见下面 ChangelogContentStatus）。
 * 六值都是稳定代号（进日志枚举与面板分支判断），改一字就是改契约。
 */
export const CHANGELOG_STATUSES = ['ok', 'empty', 'missing', 'fetch-failed', 'parse-degraded', 'cache-hit'] as const
export type ChangelogStatus = (typeof CHANGELOG_STATUSES)[number]

/** 内容态：取数/文本本身给出的结论，不含「本次是不是回缓存」这个取数方式位。 */
export type ChangelogContentStatus = Exclude<ChangelogStatus, 'cache-hit'>

/**
 * 日志 `degraded` 位（#213）：只有 `ok` 算「有可用内容」，其余内容态（empty/missing/fetch-failed/parse-degraded）
 * 都是降级——老写法 `markdown === null` 与它在 ok/empty/missing 上同结论，多出来的只是 parse-degraded 那一格。
 * 传进来的必须是**内容态**（`ChangelogContentStatus`）；认不出的野值一律算降级（宁可多报，不可漏报）。
 */
export function isChangelogDegraded(status: unknown): boolean {
  return status !== 'ok'
}

/** 截断台账里是否真动过手（#213：老写法 `report.truncation ? true : false` 恒为 true，是死信号）。 */
export function isChangelogTruncated(tr: ChangelogTruncation | null | undefined): boolean {
  if (!tr || typeof tr !== 'object') return false
  return (
    tr.chars === true ||
    tr.tailVersions > 0 ||
    tr.entries > 0 ||
    tr.sections > 0 ||
    tr.sectionItems > 0 ||
    tr.items > 0
  )
}

/** 认不认这个代号（老宿主/手搓回包不带或带野值时，面板必须回老文案而不是瞎猜）。 */
export function isChangelogStatus(value: unknown): value is ChangelogStatus {
  return typeof value === 'string' && (CHANGELOG_STATUSES as readonly string[]).indexOf(value) >= 0
}

/**
 * 文本 → 内容态（纯函数，不抛错）。`undefined`/null 一律 `missing`（调用方若知道是取数失败，
 * 该走 `fetch-failed`，别拿 null 冒充「没这个文件」——#213 要除的就是这口锅）。
 */
export function classifyChangelog(markdown: unknown): ChangelogContentStatus {
  if (typeof markdown !== 'string') return 'missing'
  if (!markdown.trim()) return 'empty'
  try {
    return parseChangelogReport(markdown).entries.length ? 'ok' : 'parse-degraded'
  } catch {
    return 'parse-degraded'
  }
}

/** 该节是否有可见内容（六类任一非空，或自定义小节里有条目）。 */
export function hasVisibleSections(entry: ChangelogEntry | null | undefined): boolean {
  if (!entry || typeof entry !== 'object') return false
  try {
    if (CHANGELOG_ALL_CATEGORIES.some((c) => Array.isArray(entry.sections?.[c]) && entry.sections[c].length > 0)) return true
    const other = entry.otherSections
    return Array.isArray(other) && other.some((s) => Array.isArray(s?.items) && s.items.length > 0)
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

export function escapeChangelogHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
