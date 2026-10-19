// src/core/i18n/text.ts —— 单语语义块渲染（原 src/bilingual.ts 的表现层；#54 底座，#60 起改为单语出口）。
//
// 字典数据在 ./dictionary.ts；本文件只做「key + lang → 一种语言的文本/HTML」的纯函数渲染。
// - 一次只渲染一种语言，语义块仍带 lang 属性（lang="en" 或 lang="zh"，只出现一个）。
// - copyHTML/copyText 吃显式 lang 入参、纯函数；bilingualHTML/bilingualText 是历史名包装（读全局语言信号）。
// - 变量与自由文本不译：{version}/{count} 等占位原样透传，冻结词元两语言逐字相同。
// - 占位为具名槽：英文语序可与中文不同（format 按名替换，不按位置拼）。
// - draft 诚实态（#53 Q3）：本文件只提供 draftKeys() 供 #56 门禁读，零 draft 放行由门禁执行。

import { normalizeLangTag, resolveLang, type AppLang } from '../../shared/lang.js'
import { BILINGUAL_STRINGS, type BilingualEntry, type BilingualKey } from './dictionary.js'

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
