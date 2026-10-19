// src/panel/theme.ts —— 面板主题：主题名归一 + 主题变量覆盖（第三方换肤的一等口径）。
//
// 从 src/panel.ts 拆出（#226，蓝图 §4：panel/theme）。纯函数：只校验主题名与 token 值、
// 把 token 拼成内联 style；不碰 DOM、不碰宿主。公开名由 src/panel.ts 入口壳统一转出
// （normalizePanelTheme / isSafeThemeCssValue / themeTokensStyleFor / UpdateThemeTokens）。

/**
 * 主题归一：`archive` 挂 `data-theme="archive"`，其余一律回 `default`（DOM 属性只出 `archive`）；
 * 其余一律回 default（纯渲染函数永不抛；挂载/setTheme 的非法值另行抛错）。
 */
export function normalizePanelTheme(value: unknown): 'default' | 'archive' {
  return value === 'archive' ? 'archive' : 'default'
}

// ---------- 主题变量覆盖（第三方换肤的一等口径） ----------
//
// 口径只有一套：与样式表里的 `--dsh-update-*` 变量逐一对应；`themeTokens` 只是把同一套变量
// 以内联方式写到面板根上，手写 CSS 变量同样生效。内联写在根元素，变量天然继承：单面板、
// 批量面板（含展开的详情行）、入口件打开的 dialog 全生效；两个主题通用。
// 被覆盖的 token 不再跟随深色媒体查询（内联赢过媒体块，即固定值，调用方自己保证深色可读）。
// 非法即抛（未知键、空串、注入字符、非正有限 entryScale 都不收），与 theme/sizing 同口径。

/** 第三方主题变量覆盖：键为语义名；颜色收 hex（#rgb/#rrggbb/#rrggbbaa）或英文名单词；其余收安全 CSS 值；缺省即主题默认值，零回归。 */
export interface UpdateThemeTokens {
  text?: string; textMuted?: string; bg?: string; bgSoft?: string;
  border?: string; borderStrong?: string; buttonBg?: string;
  primary?: string; primaryDeep?: string; focus?: string;
  okBg?: string; okBorder?: string; okText?: string;
  warnBg?: string; warnBorder?: string; warnText?: string;
  badBg?: string; badBorder?: string; badText?: string;
  busyBg?: string; busyBorder?: string; busyText?: string;
  /** 有新版版本号的醒目红（#71 Q1 专用；缺省跟随坏项红的对比度口径，深浅主题另覆）。 */
  newText?: string;
  /** 已装好新版版本号的绿色（#71 状态跟随修订：done 行走绿，其余走红；深浅主题另覆）。 */
  newOkText?: string;
  fontSans?: string; fontSerif?: string; fontMono?: string; shadow?: string;
  radiusPanel?: string; radiusButton?: string; radiusBadge?: string;
  entryFontSize?: string; entryPadding?: string; entryBorderRadius?: string;
  /** 入口件整体缩放（对应 CSS `zoom`），须为大于 0 的有限数。 */
  entryScale?: number;
  /** 面板正文字号基准（默认 `14px`；传了只改变量值，不改结构）。 */
  panelFontSize?: string;
  /** 面板章节标题字号（默认主题 `14px` / 档案卷 `17px`；批量标题 `15px` / 档案卷 `21px` 同走此键，各自回退不同）。 */
  panelChapterFontSize?: string;
  /** 面板横幅标题字号（默认跟随正文继承 / 档案卷 `27px`、已最新 `24px`；传了即固定值）。 */
  panelBannerTitleFontSize?: string;
  /** 面板日志字号（默认 `13px` 系：手册/队列/日志/更新日志体；档案卷日志体 `13.5px`、命令块 `12.5px` 各自回退不同）。 */
  panelLogFontSize?: string;
  /** 面板小字字号（副行/注脚系：默认 `11px`–`12.5px` 按规则回退不同，传了即统一固定值）。 */
  panelSmallFontSize?: string;
}

/** 语义键 → CSS 变量（顺序即序列化顺序，输出稳定可测）。 */
const THEME_TOKEN_VARS: { [K in keyof UpdateThemeTokens]-?: string } = {
  text: '--dsh-update-text', textMuted: '--dsh-update-text-muted',
  bg: '--dsh-update-bg', bgSoft: '--dsh-update-bg-soft',
  border: '--dsh-update-border', borderStrong: '--dsh-update-border-strong',
  buttonBg: '--dsh-update-button-bg',
  primary: '--dsh-update-primary', primaryDeep: '--dsh-update-primary-deep',
  focus: '--dsh-update-focus',
  okBg: '--dsh-update-ok-bg', okBorder: '--dsh-update-ok-border', okText: '--dsh-update-ok-text',
  warnBg: '--dsh-update-warn-bg', warnBorder: '--dsh-update-warn-border', warnText: '--dsh-update-warn-text',
  badBg: '--dsh-update-bad-bg', badBorder: '--dsh-update-bad-border', badText: '--dsh-update-bad-text',
  busyBg: '--dsh-update-busy-bg', busyBorder: '--dsh-update-busy-border', busyText: '--dsh-update-busy-text',
  newText: '--dsh-update-new-text',
  newOkText: '--dsh-update-new-ok-text',
  fontSans: '--dsh-update-font-sans', fontSerif: '--dsh-update-font-serif',
  fontMono: '--dsh-update-font-mono', shadow: '--dsh-update-shadow',
  radiusPanel: '--dsh-update-radius-panel', radiusButton: '--dsh-update-radius-button',
  radiusBadge: '--dsh-update-radius-badge',
  entryFontSize: '--dsh-update-entry-font-size', entryPadding: '--dsh-update-entry-padding',
  entryBorderRadius: '--dsh-update-entry-border-radius', entryScale: '--dsh-update-entry-scale',
  panelFontSize: '--dsh-update-panel-font-size',
  panelChapterFontSize: '--dsh-update-panel-chapter-font-size',
  panelBannerTitleFontSize: '--dsh-update-panel-banner-title-font-size',
  panelLogFontSize: '--dsh-update-panel-log-font-size',
  panelSmallFontSize: '--dsh-update-panel-small-font-size',
};

/** 颜色键集合：只收 hex 或英文名单词（含 transparent/currentColor）。 */
const THEME_TOKEN_COLOR_KEYS: ReadonlySet<string> = new Set([
  'text', 'textMuted', 'bg', 'bgSoft', 'border', 'borderStrong', 'buttonBg',
  'primary', 'primaryDeep', 'focus',
  'okBg', 'okBorder', 'okText', 'warnBg', 'warnBorder', 'warnText',
  'badBg', 'badBorder', 'badText', 'busyBg', 'busyBorder', 'busyText', 'newText', 'newOkText',
]);

function themeTokensError(raw: unknown): Error {
  return new Error(`[dsh-plugin-update] 主题参数 themeTokens 非法：只收已知 token 键（颜色用 hex 或英文名，字体/圆角/阴影/尺寸为安全 CSS 值，entryScale 为大于 0 的有限数）（收到 ${JSON.stringify(raw ?? null)})`)
}

/** CSS 值最小安全检查（与入口件 sizing 同口径）：放 style 属性前先拦掉注入。 */
export function isSafeThemeCssValue(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 200) return false
  if (/[;"'<>\`{}!&]/.test(v)) return false
  if (/url\s*\(/i.test(v)) return false
  if (/expression\s*\(/i.test(v)) return false
  if (/javascript\s*:/i.test(v)) return false
  return true
}

/** 颜色值检查：hex（#rgb/#rrggbb/#rrggbbaa）或英文名单词，不接受函数写法（rgb()/color-mix() 请换算成 hex）。 */
function isThemeColorValue(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 100) return false
  return /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|[a-zA-Z]+)$/.test(v)
}

/**
 * `themeTokens` → 根 style 属性体（纯函数：同一输入永远算出同一串；空/缺省回空串，即不写 style）。
 * 非法即抛（未知键、空串、注入字符、颜色形状不对、非正有限 entryScale 都不收）。
 */
export function themeTokensStyleFor(tokens: UpdateThemeTokens | null | undefined): string {
  if (tokens === undefined || tokens === null) return ''
  if (typeof tokens !== 'object' || Array.isArray(tokens)) throw themeTokensError(tokens)
  for (const key of Object.keys(tokens)) {
    if (!Object.prototype.hasOwnProperty.call(THEME_TOKEN_VARS, key)) throw themeTokensError(tokens)
  }
  const parts: string[] = []
  for (const key of Object.keys(THEME_TOKEN_VARS) as (keyof UpdateThemeTokens)[]) {
    const value = (tokens as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (key === 'entryScale') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw themeTokensError(tokens)
      parts.push(THEME_TOKEN_VARS[key] + ':' + String(value))
      continue
    }
    if (typeof value !== 'string') throw themeTokensError(tokens)
    const text = value.trim()
    if (THEME_TOKEN_COLOR_KEYS.has(key)) {
      if (!isThemeColorValue(text)) throw themeTokensError(tokens)
    } else if (!isSafeThemeCssValue(text)) throw themeTokensError(tokens)
    parts.push(THEME_TOKEN_VARS[key] + ':' + text)
  }
  return parts.join(';')
}
