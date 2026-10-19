/**
 * src/core/changelog/render-model.ts —— 包内 CHANGELOG.md 的面板 HTML 渲染（自旧 src/changelog.ts 拆出）。
 *
 * 行为零变化：一切文本先转义再拼标签（永不直通 HTML）、只认 http/https、未闭合标记按字面输出、
 * 图片只出占位不联网、纯函数永不抛错。解析常量与助手在 parse.ts。
 */

import { copyText } from '../i18n/text.js'
import { normalizeLangTag, type AppLang } from '../../shared/lang.js'
import {
  CHANGELOG_MAX_ENTRIES,
  CHANGELOG_MAX_ENTRY_DEPTH,
  CHANGELOG_ALL_CATEGORIES,
  type ChangelogCategory,
  CHANGELOG_MUST_SHOW,
  CHANGELOG_FOLDED,
  CHANGELOG_CATEGORY_ZH,
  type ChangelogEntry,
  type ChangelogTruncation,
  isCategoryName,
  isUnreleasedVersion,
  truncateBullet,
  indentLevel,
  RE_BULLET,
  isFenceToggle,
  changelogCategoryLabel,
  changelogFoldedLabel,
  splitBreakingPrefix,
  hasVisibleSections,
  selectChangelogEntries,
  escapeChangelogHtml,
} from './parse.js'

/**
 * 行内 Markdown 支持面（野外取样结论见 `docs/research/20261014-changelog-markdown-sample.md`）：
 * `code`／`**strong**`／`*em*`／`~~del~~`／`[文本](http(s) URL)`／`<http(s) URL>`／裸 URL／`![alt](url)` 占位块。
 *
 * 契约（改这块不许破）：
 * - **永不直通 HTML**：一切文本先转义再拼标签（野外反例：作者原文里的 `dsh-im<channel>`）；
 * - **只认 http/https**：`javascript:`、`data:`、`file:` 等一律按字面文本输出，永不产出可点协议；
 * - **未闭合标记按字面输出**：渲染器不猜、不吞字，输出永远标签配平（截断可能把 `**` 切成一半）；
 * - **不联网**：图片只出占位（`data-src`），不产出 `<img>`、不发任何请求；
 * - 纯函数、永不抛错、无副作用。
 */
export const CHANGELOG_MD_INLINE = ['code', 'strong', 'em', 'del', 'link', 'autolink', 'url', 'image'] as const

/** 链接目标长度上限：超长一律按字面文本（防畸形输入把面板撑爆）。 */
const MD_URL_MAX = 2048
/** 行内递归上限：`**a *b* c**` 这类嵌套只进两层，再深按字面输出。 */
const MD_MAX_DEPTH = 2

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(String(u || ''))
}

/**
 * 截断（`truncateBullet` 按字符切）可能把 `` ` ``／`**` 从中间切开，留下悬空标记。
 * 只在**标记确实没被消费掉**时才剥：渲染一遍，若可见文本里还留着裸标记串，说明它没配上对，
 * 就把源码里最后那个同类标记删掉再渲染（最多三轮）；配平的一对渲染后是标签，可见文本里没有裸标记，原样保留。
 *
 * 只处理 `**`／`__`／`~~`／`` ` `` 这四种成对标记：单个 `*`／`_` 在 URL 与算式里太常见，
 * 误删风险大于收益。
 */
function renderInlineTailAware(s: string): string {
  let src = s
  let out = renderInlineMarkdown(src, 0)
  if (!s.endsWith('…')) return out
  for (let round = 0; round < 3; round++) {
    let visible = ''
    try {
      visible = out.replace(/<code[^>]*>[\s\S]*?<\/code>/g, '').replace(/<[^>]*>/g, '')
    } catch {
      break
    }
    const m = visible.match(/\*\*|__|~~|`/)
    if (!m) break
    const marker = m[0]
    const at = src.lastIndexOf(marker)
    if (at < 0) break
    src = src.slice(0, at) + src.slice(at + marker.length)
    out = renderInlineMarkdown(src, 0)
  }
  return out
}

/** `[文本](url)` 扫描（返回结束下标；畸形/超长一律 null，交给字面输出）。 */
function matchBracketLink(s: string, openIdx: number): { text: string; url: string; end: number } | null {
  try {
    if (s[openIdx] !== '[') return null
    const close = s.indexOf(']', openIdx + 1)
    if (close < 0 || s[close + 1] !== '(') return null
    const urlEnd = s.indexOf(')', close + 2)
    if (urlEnd < 0) return null
    const raw = s.slice(close + 2, urlEnd).trim()
    if (!raw || raw.length > MD_URL_MAX) return null
    const url = raw.split(/\s+/)[0] || ''
    if (!url) return null
    return { text: s.slice(openIdx + 1, close), url, end: urlEnd + 1 }
  } catch { return null }
}

/** 裸 URL 收尾：尾部句读（含中文标点）不算 URL；右括号只在没配平时才丢。 */
function trimBareUrl(raw: string): string {
  let u = String(raw || '')
  while (u.length > 0 && /[.,;:!?'"”’、。，；：！？]/.test(u[u.length - 1] as string)) u = u.slice(0, -1)
  while (u.endsWith(')')) {
    const open = (u.match(/\(/g) || []).length
    const close = (u.match(/\)/g) || []).length
    if (close <= open) break
    u = u.slice(0, -1)
  }
  return u
}

function mdAnchor(url: string, inner: string): string {
  return '<a class="dsh-upd-md-link" data-openlink="1" href="' + escapeChangelogHtml(url) +
    '" target="_blank" rel="noopener noreferrer">' + inner + '</a>'
}

function renderInlineMarkdown(text: string, depth: number): string {
  const s = String(text ?? '')
  if (!s) return ''
  if (depth > MD_MAX_DEPTH) return escapeChangelogHtml(s)
  let out = ''
  let i = 0
  const n = s.length
  while (i < n) {
    const c = s[i] as string
    // 1) 反斜杠转义：`\*` 按字面星号
    if (c === '\\' && i + 1 < n && /[\\`*_~[\]()!<>#|]/.test(s[i + 1] as string)) {
      out += escapeChangelogHtml(s[i + 1] as string)
      i += 2
      continue
    }
    // 2) 行内代码：反引号串（1–3 个）成对才认
    if (c === '`') {
      let ticks = 1
      while (i + ticks < n && s[i + ticks] === '`' && ticks < 3) ticks++
      const fence = '`'.repeat(ticks)
      const end = s.indexOf(fence, i + ticks)
      if (end > i + ticks) {
        out += '<code class="dsh-upd-md-code">' + escapeChangelogHtml(s.slice(i + ticks, end)) + '</code>'
        i = end + ticks
        continue
      }
    }
    // 3) 图片：只出占位（不产出 <img>，不联网；非 http/https 一律按字面文本）
    if (c === '!' && s[i + 1] === '[') {
      const img = matchBracketLink(s, i + 1)
      if (img && isHttpUrl(img.url)) {
        const alt = img.text.trim() || img.url
        out += '<span class="dsh-upd-md-img" data-src="' + escapeChangelogHtml(img.url) + '" title="' +
          escapeChangelogHtml(img.url) + '">' + renderInlineMarkdown(alt, depth + 1) + '</span>'
        i = img.end
        continue
      }
    }
    // 4) 链接：只认 http/https
    if (c === '[') {
      const lk = matchBracketLink(s, i)
      if (lk && isHttpUrl(lk.url)) {
        out += mdAnchor(lk.url, renderInlineMarkdown(lk.text, depth + 1))
        i = lk.end
        continue
      }
    }
    // 5) autolink `<https://…>`
    if (c === '<') {
      const m = s.slice(i).match(/^<(https?:\/\/[^<>\s]+)>/i)
      if (m) {
        out += mdAnchor(m[1] as string, escapeChangelogHtml(m[1] as string))
        i += (m[0] as string).length
        continue
      }
    }
    // 6) 裸 URL（只吃 ASCII URL 字符：后面紧贴中文时不把汉字吞进链接）
    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(s.slice(i, i + 8))) {
      const m = s.slice(i).match(/^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%()[\]]+/i)
      if (m) {
        const url = trimBareUrl(m[0] as string)
        if (url.length > 8) {
          out += mdAnchor(url, escapeChangelogHtml(url))
          i += url.length
          continue
        }
      }
    }
    // 7) 强调族：`**strong**` / `*em*` / `__strong__` / `_em_`
    if (c === '*' || c === '_') {
      let run = 1
      while (i + run < n && s[i + run] === c && run < 2) run++
      const marker = c.repeat(run)
      const prev = i > 0 ? (s[i - 1] as string) : ''
      const inWord = c === '_' && /[0-9A-Za-z\u4e00-\u9fff]/.test(prev)
      if (!inWord) {
        const end = s.indexOf(marker, i + run)
        if (end > i + run) {
          const inner = s.slice(i + run, end)
          // 首尾不许空白（`3 * 4 * 5` 不是斜体），不跨行
          if (inner.trim() === inner && !inner.includes('\n')) {
            const tag = run === 2 ? 'strong' : 'em'
            out += '<' + tag + '>' + renderInlineMarkdown(inner, depth + 1) + '</' + tag + '>'
            i = end + run
            continue
          }
        }
      }
    }
    // 8) 删除线
    if (c === '~' && s[i + 1] === '~') {
      const end = s.indexOf('~~', i + 2)
      if (end > i + 2) {
        out += '<del class="dsh-upd-md-del">' + renderInlineMarkdown(s.slice(i + 2, end), depth + 1) + '</del>'
        i = end + 2
        continue
      }
    }
    // 9) 其余：逐字转义（HTML 永不直通）
    out += escapeChangelogHtml(c)
    i++
  }
  return out
}

/**
 * 行内 Markdown → HTML（公开纯函数，永不抛错）。
 * 输入非字符串/空串回空串；任何异常一律退回「全转义原文」，绝不让日志把面板搞崩。
 */
export function renderChangelogInline(text: unknown): string {
  try {
    const s = String(text !== null && text !== undefined ? text : '')
    if (!s) return ''
    return renderInlineTailAware(s)
  } catch {
    try { return escapeChangelogHtml(String(text !== null && text !== undefined ? text : '')) } catch { return '' }
  }
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

/**
 * 列表项识别（`- `/`* `/`+ `/`1. `/`1) `，缩进折算成层级）：块级渲染的入口判据。
 * 与解析层 `RE_BULLET` 同源同义，但不共用正则——那边只管顶格/缩进的条目归属，这边要拆标记与层级。
 */
function matchListItem(line: string): { depth: number; ordered: boolean; text: string } | null {
  const m = String(line || '').match(/^([ \t]*)(?:([-*+])|(\d{1,9}[.)]))[ \t]+(.*)$/)
  if (!m) return null
  return { depth: indentLevel(m[1] || ''), ordered: m[3] !== undefined && m[3] !== null, text: m[4] || '' }
}

/**
 * 一组列表项 → 嵌套 `<ul>`/`<ol>`（按缩进递归，深度已被解析层封顶在 `CHANGELOG_MAX_ENTRY_DEPTH`）。
 * 返回 { html, next }：next 是消费到的下标，供上层继续扫。
 */
function renderListItems(items: Array<{ depth: number; ordered: boolean; text: string }>, start: number, base: number): { html: string; next: number } {
  const first = items[start]
  const tag = first && first.ordered ? 'ol' : 'ul'
  const cls = tag === 'ol' ? 'dsh-upd-md-list-ol' : 'dsh-upd-md-list'
  let html = '<' + tag + ' class="' + cls + '">'
  let i = start
  while (i < items.length && items[i].depth >= base) {
    const it = items[i]
    if (it.depth > base) {
      // 更深一层：挂进上一个还没关的 <li>
      const sub = renderListItems(items, i, it.depth)
      html += sub.html
      i = sub.next
      continue
    }
    html += '<li>' + renderChangelogInline(it.text)
    i += 1
    const nextItem = items[i]
    if (nextItem && nextItem.depth > base) {
      const sub = renderListItems(items, i, nextItem.depth)
      html += sub.html
      i = sub.next
    }
    html += '</li>'
  }
  html += '</' + tag + '>'
  return { html, next: i }
}

/**
 * 块级渲染：把条目第一行**之后**的行渲染成嵌套列表 / 引用块 / 围栏代码块 / 续行段落。
 * 纯函数、永不抛错、一切文本先转义；认不出来的行按续行段落处理（宁可当正文，不丢字）。
 */
/** 分隔线（`---`／`***`／`___`，中间可有空格）：作者的版本/小节切分线，渲染成 `<hr>`。 */
function isThematicBreak(line: unknown): boolean {
  const t = String(line === null || line === undefined ? '' : line)
  return /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(t)
}

export function renderChangelogBlocks(lines: readonly string[]): string {
  try {
    const src = Array.isArray(lines) ? lines.map((x) => String(x === null || x === undefined ? '' : x)) : []
    const out: string[] = []
    let para: string[] = []
    const flushPara = (): void => {
      if (!para.length) return
      out.push('<div class="dsh-upd-md-para">' + renderChangelogInline(para.join(' ')) + '</div>')
      para = []
    }
    let i = 0
    while (i < src.length) {
      const line = src[i]
      if (isFenceToggle(line)) {
        flushPara()
        const code: string[] = []
        i += 1
        while (i < src.length && !isFenceToggle(src[i])) { code.push(src[i]); i += 1 }
        if (i < src.length) i += 1
        out.push('<pre class="dsh-upd-md-pre"><code class="dsh-upd-md-precode">' + escapeChangelogHtml(code.join(String.fromCharCode(10))) + '</code></pre>')
        continue
      }
      if (/^[ \t]*>/.test(line)) {
        flushPara()
        const quote: string[] = []
        while (i < src.length && /^[ \t]*>/.test(src[i])) { quote.push(src[i].replace(/^[ \t]*>[ \t]?/, '')); i += 1 }
        out.push('<blockquote class="dsh-upd-md-quote">' + renderChangelogInline(quote.join(' ')) + '</blockquote>')
        continue
      }
      if (isThematicBreak(line)) {
        flushPara()
        out.push('<hr class="dsh-upd-md-hr">')
        i += 1
        continue
      }
      const li = matchListItem(line)
      if (li) {
        flushPara()
        const items: Array<{ depth: number; ordered: boolean; text: string }> = []
        while (i < src.length) {
          const head = matchListItem(src[i])
          if (!head) break
          let text = head.text
          i += 1
          // 该子项自己的续行（更深缩进、无标记）并进这一项，不再另起一段
          while (i < src.length && !matchListItem(src[i]) && !isFenceToggle(src[i]) && !/^[ \t]*>/.test(src[i]) && !isThematicBreak(src[i])) {
            const extra = src[i].trim()
            if (extra) text += ' ' + extra
            i += 1
          }
          items.push({ depth: head.depth, ordered: head.ordered, text })
        }
        // 列表的基准层取第一项的层级：全组都是子条目时不再套一层空 `<ul>`。
        out.push(renderListItems(items, 0, items.length > 0 ? items[0].depth : 0).html)
        continue
      }
      const text = line.trim()
      if (text) para.push(text)
      i += 1
    }
    flushPara()
    return out.join('')
  } catch {
    return ''
  }
}

/**
 * 条目正文是否已经以本类名开头（`**Added** · …`、`` `Fixed` ``、`Added: …`、`新增 · …`）。
 * 档案卷皮肤用 CSS 给每条补一次红字类名前缀（原型 `.logver`），正文自己写了类名时就不该再补，
 * 否则面板上会出现「Added · Added · …」。判定只认「名字 + 边界」，`Addendum`／`新增功能` 不算。
 */
function leadsWithCategoryName(item: string, cat: ChangelogCategory): boolean {
  const first = String(item !== null && item !== undefined ? item : '').split(String.fromCharCode(10))[0].trim()
  if (!first) return false
  const bare = first.replace(/^[*_`~\s]+/, '')
  for (const name of [String(cat), CHANGELOG_CATEGORY_ZH[cat]]) {
    if (!name) continue
    if (bare.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue
    const next = bare.slice(name.length, name.length + 1)
    if (!next) return true
    if (/[\s·:：,，)）\]】\-—–、。.;；/|｜*_`~]/.test(next)) return true
  }
  return false
}

/** 单条目 HTML（含破坏标记徽标与前缀加粗，正文走行内 Markdown 渲染；#66 徽标与无障碍名入字典单语，lang 缺省 zh 零回归）。 */
export function renderChangelogItem(item: string, lang?: AppLang | string | null, cat?: ChangelogCategory | string | null): string {
  try {
    const l = normalizeLangTag(lang ?? 'zh')
    const s = String(item !== null && item !== undefined ? item : '');
    if (!s) return '';
    const nlIdx = s.indexOf(String.fromCharCode(10));
    const firstLine = nlIdx === -1 ? s : s.slice(0, nlIdx);
    // 第一行本身就是块级构造（顶格围栏 / 引用 / 列表项）：整条交给块级渲染——它是独立块，不是「条目正文」。
    // 档案卷皮肤据此跳过红字类名前缀（免得在代码块前面挂一个孤零零的「Added ·」）。
    if (/^[ \t]*(?:```|~~~|>|[-*+][ \t]|\d{1,9}[.)][ \t]|[-*_]{3,}\s*$)/.test(firstLine)) {
      const blockLead = cat && isCategoryName(String(cat)) ? ' data-cat-block="1"' : '';
      const blockHtml = renderChangelogBlocks(s.split(String.fromCharCode(10)));
      return blockHtml ? '<li' + blockLead + '>' + blockHtml + '</li>' : '';
    }
    // 多行条目：第一行是条目正文（破坏标记徽标只认第一行），其余行交给块级渲染。
    const head = firstLine;
    const tail = nlIdx === -1 ? [] : s.slice(nlIdx + 1).split(String.fromCharCode(10));
    const tailHtml = renderChangelogBlocks(tail);
    // 档案卷皮肤据此跳过重复的类名前缀（皮肤用，默认主题不看这个属性）。
    const lead = cat && isCategoryName(String(cat)) && leadsWithCategoryName(head, String(cat) as ChangelogCategory) ? ' data-cat-lead="1"' : '';
    if (!head) return tailHtml ? '<li' + lead + '>' + tailHtml + '</li>' : '';
    const split = splitBreakingPrefix(head);
    if (!split) return '<li' + lead + '>' + renderChangelogInline(head) + tailHtml + '</li>';
    const headHtml = renderChangelogInline(split.head);
    const prefix = renderChangelogInline(split.prefix);
    const rest = renderChangelogInline(split.rest);
    const badgeText = copyText('changelog.breaking.badge', l)
    const badgeAria = copyText('changelog.breaking.aria', l)
    const badge = '<span class="dsh-upd-breaking-badge" role="img" aria-label="' + escapeChangelogHtml(badgeAria) + '">' + escapeChangelogHtml(badgeText) + '</span> ';
    return '<li' + lead + '>' + headHtml + badge + '<strong>' + prefix + '</strong>' + rest + tailHtml + '</li>';
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
        const li = renderChangelogItem(item, l, cat);
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
        const li = renderChangelogItem(item, l, cat);
        if (li) parts.push(li);
      }
      parts.push('</ul></details>');
    }
    // 六类之外的小节（作者自定义 `### 标题` / 没写分类标题的裸条目）：六类之后按原文顺序补上。
    for (const block of renderOtherSections(entry, l)) parts.push(block);
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

/** 自定义小节 HTML（作者自己的 `### 标题` 或没写分类标题的裸条目）：标题原样保留，只做行内渲染。 */
function renderOtherSections(entry: ChangelogEntry, l: AppLang | string): string[] {
  const out: string[] = []
  const list = Array.isArray(entry.otherSections) ? entry.otherSections : []
  for (const s of list) {
    const items = Array.isArray(s?.items) ? s.items : []
    if (items.length === 0) continue
    const title = String(s.title || '').trim()
    out.push('<div class="dsh-upd-changelog-cat" data-cat="other">')
    if (title) out.push('<div class="dsh-upd-changelog-catname">' + renderChangelogInline(title) + '</div>')
    const total = typeof s.count === 'number' && s.count > items.length ? s.count : items.length
    if (total > items.length) out.push(truncatedNoteHTML(total, items.length, l))
    out.push('<ul>')
    for (const item of items) {
      if (!item) continue
      const li = renderChangelogItem(item, l, null)
      if (li) out.push(li)
    }
    out.push('</ul>')
    out.push('</div>')
  }
  return out
}

/**
 * 文档级截断说明（0.16.0 起：切掉多少写在面板上，不再静默丢）。
 * 三个上限各有各的话：文件 64 KiB、版本节 100 个；单类 200 条由 `truncatedNoteHTML` 在小节头上说。
 */
export function truncationNoteHTML(tr: ChangelogTruncation | null | undefined, lang?: AppLang | string | null): string {
  try {
    const l = normalizeLangTag(lang ?? 'zh')
    if (!tr || typeof tr !== 'object') return ''
    const parts: string[] = []
    if (tr.chars === true) {
      parts.push(copyText('changelog.truncated.file', l))
      const n = Number(tr.tailVersions) || 0
      if (n > 0) parts.push(copyText('changelog.truncated.versions', l, { n: String(n) }))
    }
    const droppedEntries = Number(tr.entries) || 0
    if (droppedEntries > 0) {
      parts.push(copyText('changelog.truncated.count', l, {
        n: String(CHANGELOG_MAX_ENTRIES),
        m: String(CHANGELOG_MAX_ENTRIES + droppedEntries),
      }))
    }
    if (parts.length === 0) return ''
    return '<div class="dsh-upd-changelog-truncnote">' + escapeChangelogHtml(parts.join(' ')) + '</div>'
  } catch { return '' }
}

/**
 * 区间渲染 HTML（纯函数）：
 * entries 非数组/空、无可见区间内容一律回中性提示；
 * Unreleased 与空节永不渲染；输出已转义，可直接拼进面板。
 * `opts.truncated`（0.16.0 新增，可选）：解析期的丢字账本，有丢就在日志块头上说明。
 */
export function renderChangelogHTML(
  entries: unknown,
  opts?: { from?: string | null; to?: string | null; lang?: AppLang | string | null; truncated?: ChangelogTruncation | null },
): string {
  try {
    const l = normalizeLangTag((opts as { lang?: unknown } | undefined)?.lang ?? 'zh')
    const note = truncationNoteHTML((opts as { truncated?: ChangelogTruncation | null } | undefined)?.truncated, l)
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
    if (ranged.length === 0) return note + renderChangelogNeutral(l)
    const blocks = ranged.map((e) => renderChangelogSection(e, l)).filter((s) => !!s)
    if (blocks.length === 0) return note + renderChangelogNeutral(l)
    return `<div class="dsh-upd-changelog">\n${note}${blocks.join('\n')}\n</div>`
  } catch {
    try { const ll = normalizeLangTag((opts as { lang?: unknown } | undefined)?.lang ?? 'zh'); return renderChangelogNeutral(ll) } catch { return ''; }
  }
}
