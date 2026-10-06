// src/bilingual.ts —— 集中文案底座与双语语义块渲染（#54，承接 #52 清单 + #53 结论 + #57 规格）。
//
// 地位：唯一新接缝（#57 Testing Decisions 主接缝），最高处，一处覆盖全部消费方。
// 数据层永不拼串：调用方只传 key + 具名值（{version} 等运行时值），表现层按语义块拼装。
// 分支只认稳定码：本模块不做任何分支，调用方（entry/panel）只用快照 + 稳定码选 key，永不读文案做判断。
//
// 契约（#57 Implementation Decisions 双语语义块契约）：
// - 英文在前中文在后，空白分隔，窄处竖排，语义块带语言属性（lang="en" / lang="zh"）。
// - 变量与自由文本不译：{version} 等占位原样透传，同一值在中英两 span 各出现一次。
// - 占位为具名槽：英文语序可与中文不同（format 按名替换，不按位置拼）。
// - draft 诚实态（#53 Q3）：无母语评审即标 draft；底座钉住字典版本开发（BILINGUAL_DICT_VERSION），
//   draft 不卡 #54，转正只换文案不换 key；零 draft 放行由 #56 门禁执行，本模块只提供 draftKeys() 供门禁读。
//
// 范围（本票只打通一路调用链）：首批仅收 entry 7 键（#52 §1 全量，E1-E7）。
// panel / batch / changelog / diag 复用后续票展开，本文件不预占它们的 key（避免双源）。
// CHANGELOG 六类标题唯一源仍是 changelog.ts CATEGORY_ZH，本模块不另起第二套映射。

/** 字典版本钉（#53 Q3 解耦）：key 冻即解阻塞 #54，文案按词标 draft/locked；开发钉此版本，转正只换文案不换 key。 */
export const BILINGUAL_DICT_VERSION = '2026-10-06-pin53'

/** 首批 key 全集（entry 7 键，命名沿 #52 §1 key 提案，area.group.name）。 */
export type BilingualKey =
  | 'entry.label.idle'
  | 'entry.label.failed'
  | 'entry.label.busy'
  | 'entry.label.restart'
  | 'entry.label.has-update'
  | 'entry.action.checking'
  | 'entry.note.up-to-date'

/** 一条双语：en/zh 模板 + 成熟度。模板内具名槽如 {version}，运行时值填入（值永不翻译）。 */
export interface BilingualEntry {
  en: string
  zh: string
  /** true=待母语+域内双签（#53 Q3），false=已双签转正。首批全 draft（无评审不假锁）。 */
  draft: boolean
}

/**
 * 集中字典（机器源，类型锁死：Record<BilingualKey, BilingualEntry> 缺键即 tsc 报错）。
 * 人读源为 #57 规格 + #53 结论英文定调；英文终稿待母语评审，故全标 draft。
 * zh 逐字等于 entry.ts 现有散落文案（兼容既有测试与接入方 label() 口径）。
 */
export const BILINGUAL_STRINGS: Record<BilingualKey, BilingualEntry> = {
  'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: true },
  'entry.label.failed': { en: 'Update failed \u2014 View details', zh: '更新失败，点此查看', draft: true },
  'entry.label.busy': { en: 'Installing\u2026', zh: '正在安装\u2026', draft: true },
  'entry.label.restart': { en: 'Restart required', zh: '待重启', draft: true },
  'entry.label.has-update': { en: 'Update available {version}', zh: '有新版 {version}', draft: true },
  'entry.action.checking': { en: 'Checking for updates\u2026', zh: '正在查新版\u2026', draft: true },
  'entry.note.up-to-date': { en: 'Up to date {version}', zh: '已是最新 {version}', draft: true },
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 具名槽填充：{name} 按名替换（中英各自独立替换，语序可不同）；缺值填空串，永不把 {name} 漏到 UI。 */
function formatTemplate(template: string, values: Record<string, unknown> | null | undefined): string {
  const vals = values ?? {}
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const v = (vals as Record<string, unknown>)[name]
    if (v === null || v === undefined) return ''
    return String(v).trim()
  })
}

/** 取一条双语原文（类型锁死：未知 key 在 tsc 即拦；运行时未知亦抛，不静默回退）。 */
export function bilingualEntry(key: BilingualKey): BilingualEntry {
  const hit = (BILINGUAL_STRINGS as Record<string, BilingualEntry>)[key]
  if (!hit) throw new Error('[dsh-plugin-update] 未知文案 key：' + String(key))
  return hit
}

/**
 * 纯文本双语（一行，英文在前中文在后，空白分隔）：用于 title / aria-label 等放不下 HTML 的属性位。
 * 返回原文（未转义），调用方按上下文转义后再拼入属性。
 */
export function bilingualText(key: BilingualKey, values?: Record<string, unknown>): string {
  const e = bilingualEntry(key)
  return formatTemplate(e.en, values) + ' ' + formatTemplate(e.zh, values)
}

/**
 * 双语语义块 HTML（唯一渲染出口）：英文在前中文在后，空白分隔，lang 属性齐全。
 * 返回已转义可直接拼入 innerHTML 的片段；调用方不得再对整体转义，不得拆 span 重组。
 */
export function bilingualHTML(key: BilingualKey, values?: Record<string, unknown>): string {
  const e = bilingualEntry(key)
  const en = escapeHtml(formatTemplate(e.en, values))
  const zh = escapeHtml(formatTemplate(e.zh, values))
  return '<span class="dsh-upd-bi"><span lang="en">' + en + '</span> <span lang="zh">' + zh + '</span></span>'
}

/** 是否 draft（供 #56 门禁读零 draft 放行条件；#54 自身不断言零 draft）。 */
export function isDraft(key: BilingualKey): boolean {
  return bilingualEntry(key).draft
}

/** 全表 draft key 一览（#56 门禁：空数组才放行合入主分支）。 */
export function draftKeys(): BilingualKey[] {
  return (Object.keys(BILINGUAL_STRINGS) as BilingualKey[]).filter((k) => BILINGUAL_STRINGS[k].draft)
}

/**
 * 双语块最小样式（与 UPDATE_ENTRY_CSS 同缝注入）：
 * 平时行内双语（英文前中文后，空白分隔），窄处竖排不断行（@media 360px 以下 column）。
 * 只管排版，不管字重字号（字重间距留给 #55 视觉矩阵验收）。
 */
export const BILINGUAL_CSS = [
  '.dsh-upd-bi{display:inline-flex;align-items:baseline;gap:.5em;max-width:100%}',
  '.dsh-upd-bi [lang="en"],.dsh-upd-bi [lang="zh"]{overflow-wrap:anywhere}',
  '@media (max-width:360px){.dsh-upd-bi{flex-direction:column;gap:0}}',
].join('\n')
