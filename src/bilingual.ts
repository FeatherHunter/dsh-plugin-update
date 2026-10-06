// src/bilingual.ts —— 集中文案底座与单语语义块渲染（#54 底座，#60 起改为单语出口）。
//
// 历史名说明（#60 执行约定命名收敛二选一之二）：文件名 src/bilingual.ts、导出名 BILINGUAL_*、
// 类名 dsh-upd-bi 均为历史名，v2 起为单语出口（一次只渲染一种语言），保留旧名以免门禁白名单与测试大改。
// 地位：唯一新接缝（#57 Testing Decisions 主接缝），最高处，一处覆盖全部消费方。
// 数据层永不拼串：调用方只传 key + 具名值（{version}/{count} 等运行时值），表现层按语义块拼装。
// 分支只认稳定码：本模块不做任何分支，调用方（entry/panel）只用快照 + 稳定码选 key，永不读文案做判断。
//
// 契约（#57 语言契约 v2，取代同显）：
// - 一次只渲染一种语言，语义块仍带 lang 属性（lang="en" 或 lang="zh"，只出现一个）。
// - 核心渲染吃显式 lang 入参、纯函数：copyHTML(key, lang, values) / copyText(key, lang, values)。
// - 变量与自由文本不译：{version}/{count} 等占位原样透传，冻结词元两语言逐字相同。
// - 占位为具名槽：英文语序可与中文不同（format 按名替换，不按位置拼）。
// - draft 诚实态（#53 Q3）：无母语评审即标 draft；底座钉住字典版本开发（BILINGUAL_DICT_VERSION），
//   draft 不卡 #54，转正只换文案不换 key；零 draft 放行由 #56 门禁执行，本模块只提供 draftKeys() 供门禁读。
//
// 范围（#60 起两条入口链）：entry 7 键（#52 §1 全量，E1-E7）+ batch-entry 6 键（聚合按钮）。
// panel / panel-batch / changelog / diag 复用后续票展开，本文件不预占它们的 key（避免双源）。
// CHANGELOG 六类标题唯一源仍是 changelog.ts CATEGORY_ZH，本模块不另起第二套映射。

import { normalizeLangTag, resolveLang, type AppLang } from './lang.js'

/** 字典版本钉（#53 Q3 解耦）：key 冻即解阻塞 #54，文案按词标 draft/locked；开发钉此版本，转正只换文案不换 key。 */
export const BILINGUAL_DICT_VERSION = '2026-10-06-pin53'

/** key 全集（entry 7 键 + batch-entry 6 键，命名沿 #52 §1 key 提案，area.group.name；既有 7 键 en/zh/draft 不动）。 */
export type BilingualKey =
  | 'entry.label.idle'
  | 'entry.label.failed'
  | 'entry.label.busy'
  | 'entry.label.restart'
  | 'entry.label.has-update'
  | 'entry.action.checking'
  | 'entry.note.up-to-date'
  | 'batch-entry.label.idle'
  | 'batch-entry.label.update'
  | 'batch-entry.label.busy'
  | 'batch-entry.label.restart'
  | 'batch-entry.label.failed'
  | 'batch-entry.action.checking'

/** 一条双语：en/zh 模板 + 成熟度。模板内具名槽如 {version}/{count}，运行时值填入（值永不翻译）。 */
export interface BilingualEntry {
  en: string
  zh: string
  /** true=待母语+域内双签（#53 Q3），false=已双签转正。首批与新增全 draft（无评审不假锁）。 */
  draft: boolean
}

/**
 * 集中字典（机器源，类型锁死：Record<BilingualKey, BilingualEntry> 缺键即 tsc 报错）。
 * 人读源为 #57 规格 + #53 结论英文定调；英文终稿待母语评审，故全标 draft。
 * zh 逐字等于 entry.ts / entry-batch.ts 既有散落文案（兼容既有测试与接入方 label() 口径）。
 */
export const BILINGUAL_STRINGS: Record<BilingualKey, BilingualEntry> = {
  'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: true },
  'entry.label.failed': { en: 'Update failed \u2014 View details', zh: '更新失败，点此查看', draft: true },
  'entry.label.busy': { en: 'Installing\u2026', zh: '正在安装\u2026', draft: true },
  'entry.label.restart': { en: 'Restart required', zh: '待重启', draft: true },
  'entry.label.has-update': { en: 'Update available {version}', zh: '有新版 {version}', draft: true },
  'entry.action.checking': { en: 'Checking for updates\u2026', zh: '正在查新版\u2026', draft: true },
  'entry.note.up-to-date': { en: 'Up to date {version}', zh: '已是最新 {version}', draft: true },
  'batch-entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: true },
  'batch-entry.label.update': { en: '{count} updates available', zh: '{count} 家可更新', draft: true },
  'batch-entry.label.busy': { en: 'Installing\u2026', zh: '正在安装\u2026', draft: true },
  'batch-entry.label.restart': { en: '{count} restarts required', zh: '{count} 家待重启', draft: true },
  'batch-entry.label.failed': { en: '{count} failed \u2014 View details', zh: '{count} 家失败，点此查看', draft: true },
  'batch-entry.action.checking': { en: 'Checking for updates\u2026', zh: '正在查新版\u2026', draft: true },
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
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_: string, name: string) => {
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
 * 单语纯文本（v2 主出口，纯函数）：只渲染 lang 那一种语言，不读全局信号。
 * lang 显式入参（'zh'/'en'/BCP47，缺省 zh）；返回原文（未转义），调用方按上下文转义后再拼入属性。
 */
export function copyText(key: BilingualKey, lang?: AppLang | string | null, values?: Record<string, unknown>): string {
  const l = normalizeLangTag(lang ?? 'zh')
  const e = bilingualEntry(key)
  return formatTemplate(l === 'en' ? e.en : e.zh, values)
}

/**
 * 单语语义块 HTML（v2 主出口，纯函数）：一次只出现一种语言，语义块仍带 lang 属性。
 * lang 显式入参（缺省 zh）；返回已转义可直接拼入 innerHTML 的片段；调用方不得再对整体转义，不得拆 span 重组。
 */
export function copyHTML(key: BilingualKey, lang?: AppLang | string | null, values?: Record<string, unknown>): string {
  const l = normalizeLangTag(lang ?? 'zh')
  const e = bilingualEntry(key)
  const text = escapeHtml(formatTemplate(l === 'en' ? e.en : e.zh, values))
  return '<span class="dsh-upd-bi"><span lang="' + l + '">' + text + '</span></span>'
}

/**
 * 历史名包装（v2 前叫双语，v2 起为单语，保留旧名见文件头说明）：
 * 无显式 lang 时按当前语言单语渲染（读全局信号），有覆盖需求请直接用 copyHTML/copyText。
 */
export function bilingualText(key: BilingualKey, values?: Record<string, unknown>): string {
  return copyText(key, resolveLang(), values)
}

/**
 * 历史名包装（见上）：无显式 lang 时按当前语言单语渲染；返回单语块（只含当前语言一个 span）。
 */
export function bilingualHTML(key: BilingualKey, values?: Record<string, unknown>): string {
  return copyHTML(key, resolveLang(), values)
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
 * 单语块最小样式（与 UPDATE_ENTRY_CSS 同缝注入）：
 * v2 起窄处竖排退场（一次只一种语言，不断行压力消失，#55 横排/竖排结论作废，排版改由 #67 仲裁）；
 * 只保留 overflow-wrap，不断行不溢出；不管字重字号。
 */
export const BILINGUAL_CSS = [
  '.dsh-upd-bi{display:inline;overflow-wrap:anywhere}',
  '.dsh-upd-bi [lang]{overflow-wrap:anywhere}',
].join('\n')
