// src/lang.ts —— 语言信号层（#60，承接 #57 语言契约 v2）。
//
// 地位：宿主是唯一语言权威，本包只取信号、不做主张。
// 信号口径＝显式覆盖（options.locale）> document.documentElement.lang > navigator.languages > 历史行为 zh。
// 已知非中文标签 → en（与宿主兜底链终点一致，其余语言落英文）；完全无信号 → zh（零回归）。
// 模块级单例观察者：MutationObserver 盯 html[lang] + 可选服务订阅（options.locale 对象带 subscribe 时）。
// 无 DOM 环境安全降级：Node/测试里不抛，落 zh，订阅永不触发（除非显式服务源触发）。
//
// 本文件零中文字符串字面量（门禁 copy-source 口径）：注释里的中文不入账，字符串里不写中文。

/** 本包跟随的两种语言：中文（历史行为）与英文（其余语言落英文）。 */
export type AppLang = 'zh' | 'en'

/** 显式覆盖的两种形态：稳定码 'zh' | 'en'，或带 getActive/subscribe 的服务对象（可注入假信号源，测试不依赖 jsdom）。 */
export interface LocaleService {
  getActive(): string
  subscribe?(cb: () => void): () => void
}

/** 入口件/面板/批量挂载点的语言选项：显式覆盖，不传即跟随全局信号。 */
export type LocaleOption = 'zh' | 'en' | LocaleService | string | null | undefined

type LangCallback = (lang: AppLang) => void

interface Entry {
  cb: LangCallback
  override: LocaleOption
  last: AppLang
  serviceUnsub: (() => void) | null
}

/**
 * 归一语言标签：zh* → zh；形如 BCP47 的已知非中文标签 → en；空/垃圾 → zh（零回归）。
 * 大小写不敏感，_ 视作 -。
 */
export function normalizeLangTag(tag: unknown): AppLang {
  if (typeof tag !== 'string') return 'zh'
  const s = tag.trim().toLowerCase().replace(/_/g, '-')
  if (!s) return 'zh'
  if (s === 'zh' || s.startsWith('zh-')) return 'zh'
  if (s === 'en' || s.startsWith('en-')) return 'en'
  // BCP47 形状（2-3 字母主码，可带区域/变体）：非中文一律落 en（第三语言包 out of scope）。
  if (/^[a-z]{2,3}(-[a-z0-9]+)*$/.test(s)) return 'en'
  return 'zh'
}

function readDocumentLang(): string | null {
  try {
    const g = globalThis as unknown as { document?: { documentElement?: { lang?: unknown } } }
    const v = g.document?.documentElement?.lang
    if (typeof v === 'string' && v.trim()) return v
  } catch {
    // 无 DOM 或读坏了即当无信号，不抛。
  }
  return null
}

function readNavigatorLangs(): string[] {
  try {
    const g = globalThis as unknown as { navigator?: { languages?: unknown; language?: unknown } }
    const nav = g.navigator
    if (!nav) return []
    const out: string[] = []
    if (Array.isArray(nav.languages)) {
      for (const c of nav.languages) {
        if (typeof c === 'string' && c.trim()) out.push(c)
      }
    }
    if (typeof nav.language === 'string' && nav.language.trim()) out.push(nav.language)
    return out
  } catch {
    return []
  }
}

/**
 * 解出当前语言：显式覆盖 > html[lang] > navigator.languages > zh。
 * 纯函数（除读全局信号外无副作用）；无信号永不抛，落 zh。
 */
export function resolveLang(override?: LocaleOption): AppLang {
  // 1. 显式覆盖：对象服务先问 getActive，字符串直接归一。
  if (override !== null && typeof override === 'object') {
    try {
      const fn = (override as LocaleService).getActive
      if (typeof fn === 'function') {
        const v = (fn as () => unknown).call(override)
        if (typeof v === 'string' && v.trim()) return normalizeLangTag(v)
        // 空串即当这次没信号，继续往下找（不直接落 zh，让 html/navigator 还有机会）。
      }
    } catch {
      // 服务抛了即当无信号，继续往下找。
    }
  } else if (typeof override === 'string' && override.trim()) {
    return normalizeLangTag(override)
  }
  // 2. html[lang]
  const docLang = readDocumentLang()
  if (docLang !== null) return normalizeLangTag(docLang)
  // 3. navigator.languages / language：取第一个可归一的非空信号。
  const navs = readNavigatorLangs()
  for (const c of navs) {
    // 空已过滤；归一后 zh/en 都是有效信号（无信号才落 zh，这里有信号就按口径走）。
    return normalizeLangTag(c)
  }
  // 4. 完全无信号 → zh（零回归）。
  return 'zh'
}

// ---------- 模块级单例订阅 ----------

const entries = new Set<Entry>()
let mo: { disconnect(): void } | null = null

function ensureGlobalObserver(): void {
  if (mo !== null) return
  try {
    const g = globalThis as unknown as {
      document?: { documentElement?: object }
      MutationObserver?: new (cb: () => void) => { observe(t: object, o: object): void; disconnect(): void }
    }
    const docEl = g.document?.documentElement
    const MO = g.MutationObserver
    if (!docEl || typeof MO !== 'function') return
    const obs = new MO(() => {
      notifyAll()
    })
    obs.observe(docEl, { attributes: true, attributeFilter: ['lang'] })
    mo = obs
  } catch {
    mo = null
  }
}

function notifyAll(): void {
  for (const e of [...entries]) {
    try {
      const next = resolveLang(e.override)
      if (next !== e.last) {
        e.last = next
        e.cb(next)
      }
    } catch {
      // 回调抛了不连坐别的订阅者。
    }
  }
}

/**
 * 订阅语言变化：html[lang] 变化或可选服务源触发时回新语言。
 * 模块级单例：多个挂载件共用一个 MutationObserver；返回 unsubscribe，unmount 后停订。
 * 无 DOM 环境安全降级：没有 document/MutationObserver 时只记回调、永不触发，不抛。
 */
export function subscribeLang(cb: LangCallback, override?: LocaleOption): () => void {
  if (typeof cb !== 'function') throw new Error('[dsh-plugin-update] subscribeLang needs a function')
  const entry: Entry = { cb, override: override ?? undefined, last: resolveLang(override), serviceUnsub: null }
  entries.add(entry)
  ensureGlobalObserver()
  // 可选服务订阅（对象带 subscribe 时）：服务触发即按该订阅者的 override 重解一次。
  try {
    if (entry.override !== null && typeof entry.override === 'object') {
      const sub = (entry.override as LocaleService).subscribe
      if (typeof sub === 'function') {
        const un = (sub as (cb: () => void) => unknown).call(entry.override, () => {
          try {
            const next = resolveLang(entry.override)
            if (next !== entry.last) {
              entry.last = next
              entry.cb(next)
            }
          } catch {
            // 服务回调坏了不抛。
          }
        })
        if (typeof un === 'function') entry.serviceUnsub = un as () => void
      }
    }
  } catch {
    // 服务接不上即只剩全局信号，不抛。
  }
  let done = false
  return () => {
    if (done) return
    done = true
    entries.delete(entry)
    try {
      entry.serviceUnsub?.()
    } catch {
      // 停订失败不抛。
    }
    entry.serviceUnsub = null
    if (entries.size === 0) {
      try {
        mo?.disconnect()
      } catch {
        // 停不掉也无妨。
      }
      mo = null
    }
  }
}

/** 测试/维护用：清空全部订阅并断开单例观察者（正常业务代码不调它）。 */
export function __resetLangState(): void {
  for (const e of [...entries]) {
    try {
      e.serviceUnsub?.()
    } catch {
      // ignore
    }
  }
  entries.clear()
  try {
    mo?.disconnect()
  } catch {
    // ignore
  }
  mo = null
}
