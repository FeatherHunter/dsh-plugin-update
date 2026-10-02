/**
 * src/redaction.ts —— 失败详情脱敏规则表（#19，承接 #6；#24 单源收敛）。
 *
 * 五条具名规则，顺序固定。处理方式只有两种：替换成占位符，或丢弃整项。
 * 判据是机械的：秘密片段的起止能否被规则无歧义定位（与 #5 风险序一致：误导 > 缺失）。
 *
 * - 绝对路径 → 替换为 `<路径>`（#5 冻结，不动）。路径终止于空白，起止唯一。
 * - URL 用户信息（scheme://user:pass@）→ 丢弃整项。密码自身可能含 `@`，起止不唯一。
 * - 令牌前缀（npm / GitHub / sk / Bearer 形状）→ 替换为 `<脱敏>`。
 * - 密码键值对（token / password / api_key / cookie 形状）→ 替换为 `<脱敏>`（保留键名与分隔符，只换值）。
 * - 邮箱 → 替换为 `<脱敏>`。
 *
 * 只有两个占位符：`<路径>` 与 `<脱敏>`。不为每种秘密建一套分类学。
 *
 * 处理顺序固定为：压平空白 → URL 用户信息（命中即整项丢弃）→ 路径 → 令牌 → 键值对 → 邮箱
 * → 空白边界封顶（封顶后不再扫描）。顺序的目的是输出确定性（同一输入两次运行逐字节相同），
 * 封顶在脱敏之后，且封顶之后不再扫描。
 *
 * 本模块是唯一的规则源（#24 单源收敛）：宿主侧（store.ts 经 sanitizeDetail）与面板侧
 * （panel.ts 经 redactForCopy）同缝消费，不再各存一份 PANEL_* 镜像。面板侧的复制预算
 * 1500 字也在此单源定义（COPY_BUDGET_CHARS），面板只转出口。
 * 本模块零 Node 导入（只用 URL / TextEncoder 全局），宿主与浏览器闭包两边都进得去。
 *
 * 绝不外发的三样按构造问题处理，不在文字层拦：
 * 响应正文与安装输出全文（入口不接受此类参数）、调用栈（不构造）、内网主机名
 * （不是高精度标记，是猜的——源信息隐私由源主机名字段承担，不在文字层拦）。
 *
 * 已知缺口（显式 known-gap，不静默修）：`file:///tmp/x` 三斜杠形状会被当成 URL 放过
 * （`file://` 的前置带着冒号），见 KNOWN_GAP_FILE_URL_PREFIX 与测试里的显式断言。
 * UNC 反斜杠本轮已覆盖（#19 落地时）。
 */

/** 失败详情封顶字数：回给用户的是一行人话，不是整段安装输出（与旧口径同值，落刀点改为感白边界）。 */
export const DETAIL_MAX_CHARS = 300

/**
 * 复制文本预算（字符）：面板复制诊断全文的上限，超限在空白边界截断。
 * 单源定义于此（#24 收敛前散在 panel.ts，值同为 1500，行为收敛后只此一处）。
 */
export const COPY_BUDGET_CHARS = 1500

/**
 * 内联证据预算（字节）：#5 定深证据分界约 1KB，300 字中文即 900 字节，
 * 加上溯源信息很可能越线。#24 起运行时强制执行（见 enforceDiagBudget），
 * 测试对着这个常量断言。
 */
export const DIAG_INLINE_BUDGET_BYTES = 1024

/** 脱敏占位符：路径是唯一结构上可识别的类别，单占位；其余全部共用一个。 */
export const REDACTED_PATH = '<路径>'
export const REDACTED_SECRET = '<脱敏>'

/**
 * 已知缺口前缀：`file:///` 三斜杠形状原样放过（URL 与文件系统路径的边界模糊）。
 * 显式记为 known-gap：不断言它会被掩掉，而是断言它原样通过且已被记录。
 * 若将来要覆盖，需另立规格（属 URL 与路径边界的产品决定，不顺手修）。
 */
export const KNOWN_GAP_FILE_URL_PREFIX = 'file:///'

/**
 * 五条规则的真实可引用标识（固定顺序）：事件清单的 `rules` 栏引用这些名字，
 * 而不必复述匹配形态（见 src/gate.ts）。顺序即应用顺序，改顺序即改行为。
 */
export const REDACTION_RULE_NAMES = [
  'R_ABSOLUTE_PATH',
  'R_URL_USERINFO',
  'R_TOKEN',
  'R_CRED_PAIR',
  'R_EMAIL',
] as const
export type RedactionRuleName = (typeof REDACTION_RULE_NAMES)[number]

/** 本包认可的源主机名集合：「一律官方源」政策本来就蕴含的集合，不是新增维护负担。 */
export const ENDORSED_REGISTRY_HOSTS = ['registry.npmjs.org'] as const

/**
 * 绝对路径规则（R_ABSOLUTE_PATH）：Windows 盘符、UNC 反斜杠、UNC 斜杠、POSIX 四形状，
 * 命中即换成占位。URL 里的 `//` 不受影响（判据是双斜杠出现在什么位置，不是并没并两个斜杠）。
 *
 * #24 收敛说明（阈值与键集取严侧）：
 * UNC 反斜杠取面板侧的严侧（无前置要求，句中亦掩；旧核要求前置空白/引号，句中 `foo\\s\\x` 会漏）。
 * 盘符 / UNC 斜杠 / POSIX 三分支与 #19 落地一字不动——收紧规则时的零回归比对
 * （新规则掩不掉而旧规则能掩的输入为零）靠既有 8 条 must-mask 测试守着
 * （见 tests/desktop-manager.test.mjs），另有本票新增的新旧穷举比对锁死。
 */
const ABSOLUTE_PATH_RE =
  /[A-Za-z]:\\[^\s"']*|\\\\[^\s"'()\[\];]+|(^|[\s"'(\[=,])\/\/[^\s"'()\[\];]+|(^|[\s"'(\[=:,])\/(?!\/)[^\s"'()\[\];]+/g

/** URL 用户信息探测（R_URL_USERINFO）：scheme:// 后、第一个 `/` 前出现 `@` 即命中，整项丢弃。 */
const URL_USERINFO_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]*@/

/**
 * 令牌前缀（R_TOKEN）：npm / GitHub / sk / Bearer 四形状。
 * #24 取严侧但守住不误伤：
 * - npm_ 取核侧 `{8,}`（面板侧 `{6,}` 会把 `npm_install` 吃掉，见 keeps 语料）；
 * - GitHub 取面板侧 `{8,}`（核侧 `{10,}` 偏松，`{8,}` 不误伤且多掩短令牌）；
 * - sk- 取面板侧 `{6,}`（核侧 `{8,}` 偏松，`{6,}` 不误伤）；
 * - Bearer 取核侧的保留前缀写法（面板侧整段替换丢掉 `Bearer` 可读性，秘密部分同掩），
 *   另加 `i` 旗（对抗审查补：协议关键字大小写不敏感，全大写 `BEARER` 旧两核皆漏）。
 */
const NPM_TOKEN_RE = /\bnpm_[A-Za-z0-9_-]{8,}/g
const GITHUB_TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{10,})/g
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{6,}/g
const BEARER_TOKEN_RE = /(\bbearer\s+)[A-Za-z0-9._~+/-=]{6,}/gi

/**
 * 密码键值对（R_CRED_PAIR）：键名 + `:`/`=` + 值。只换值，键名与分隔符保留，可读。
 * #24 取严侧：键集取面板侧超集（新增 `access_key` / `auth_token`，核侧无）；
 * 值取两者最严组合（面板侧的引号包住含空格值 + 核侧的无长度上限，去掉面板侧 `{1,200}` 封顶）。
 */
const CRED_PAIR_RE =
  /(\b(?:token|password|passwd|pwd|api[_-]?key|access[_-]?key|auth[_-]?token|secret|cookie)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s'";,)\]]+)/gi

/** 邮箱（R_EMAIL）：标准形状。无 TLD 的 `user@host` 不动（不是已识别的身份信息类）。 */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

function flattenWhitespace(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function applyPathRule(text: string): string {
  ABSOLUTE_PATH_RE.lastIndex = 0
  return text.replace(ABSOLUTE_PATH_RE, (_whole: string, g1: string, g2: string) => {
    const lead = g1 ?? g2 ?? ''
    return `${lead}${REDACTED_PATH}`
  })
}

function applyTokenRule(text: string): string {
  NPM_TOKEN_RE.lastIndex = 0
  GITHUB_TOKEN_RE.lastIndex = 0
  SK_TOKEN_RE.lastIndex = 0
  BEARER_TOKEN_RE.lastIndex = 0
  return text
    .replace(NPM_TOKEN_RE, REDACTED_SECRET)
    .replace(GITHUB_TOKEN_RE, REDACTED_SECRET)
    .replace(SK_TOKEN_RE, REDACTED_SECRET)
    .replace(BEARER_TOKEN_RE, (_whole: string, prefix: string) => `${prefix}${REDACTED_SECRET}`)
}

function applyCredPairRule(text: string): string {
  CRED_PAIR_RE.lastIndex = 0
  return text.replace(CRED_PAIR_RE, (_whole: string, head: string) => `${head}${REDACTED_SECRET}`)
}

function applyEmailRule(text: string): string {
  EMAIL_RE.lastIndex = 0
  return text.replace(EMAIL_RE, REDACTED_SECRET)
}

function hasUserinfo(text: string): boolean {
  URL_USERINFO_RE.lastIndex = 0
  return URL_USERINFO_RE.test(text)
}

/**
 * 空白边界落刀（通用）：max 处若在词中，退到上一个空白；末尾若把占位符切开（如 `<路`），
 * 退到占位符起点。中文无空白时退无可退，按 max 硬切（长度不变，可见行为变化须进发布说明）。
 */
export function truncateToWordBoundary(text: string, max: number): string {
  const input = String(text ?? '')
  if (input.length <= max) return input
  const slice = input.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  let cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice
  const lastOpen = cut.lastIndexOf('<')
  const lastClose = cut.lastIndexOf('>')
  if (lastOpen > lastClose) cut = cut.slice(0, lastOpen).trimEnd()
  if (!cut) cut = slice
  return `${cut}…`
}

/** 详情落刀（300 字）：占位符完整性由通用函数保证。 */
function truncateDetail(text: string): string {
  return truncateToWordBoundary(text, DETAIL_MAX_CHARS)
}

/** 复制落刀（1500 字）：与详情同一落刀语义，只换预算。 */
function truncateForCopy(text: string): string {
  return truncateToWordBoundary(text, COPY_BUDGET_CHARS)
}

function scrubWithoutBudget(text: string): string {
  return applyEmailRule(applyCredPairRule(applyTokenRule(applyPathRule(text))))
}

/**
 * 把外面世界的脏错误收成一行：压平空白 → URL 用户信息（命中整项丢弃）→ 路径 → 令牌
 * → 键值对 → 邮箱 → 300 字封顶（封顶后不再扫描）。
 * URL 用户信息命中时丢弃整项（返回空串）：密码自身可能含 `@`，起止不唯一，
 * 替换会把一次泄漏变成一次静默的错（证据被销毁），丢弃至少看得出。
 */
export function sanitizeDetail(text: string): string {
  const flat = flattenWhitespace(text)
  if (!flat) return ''
  if (hasUserinfo(flat)) return ''
  return truncateDetail(scrubWithoutBudget(flat))
}

/**
 * 复制前把一行文本收干净（#24 单源：与 sanitizeDetail 同规则同顺序，只换 1500 预算）。
 * 确定性：同一输入两次运行逐字节相同。URL 用户信息同样整项丢弃（返空串），
 * 调用方（panel.ts buildDiagnosticText）对空串回落到稳定码，不静默。
 */
export function sanitizeForCopy(text: unknown): string {
  const flat = flattenWhitespace(String(text ?? ''))
  if (!flat) return ''
  if (hasUserinfo(flat)) return ''
  return truncateForCopy(scrubWithoutBudget(flat))
}

/**
 * 源主机名规则（R 源信息）：只在命中国家认可的源时给 origin 主机名，
 * 不带用户信息、端口、路径、查询参数；客户端 IP 永不进；不认可即省略（省略本身即信息）。
 * 本函数只做规则（供 #18 的 diag 落地时调用），本票不新增任何回包键。
 */
export function resolveRegistryHost(registryUrl: string): string | null {
  try {
    const raw = String(registryUrl ?? '').trim()
    if (!raw) return null
    const host = new URL(raw).hostname.toLowerCase()
    if (!host) return null
    return (ENDORSED_REGISTRY_HOSTS as readonly string[]).includes(host) ? host : null
  } catch {
    return null
  }
}

// ---------- DIAG 1024 字节墙（运行时按序丢弃，#24 enforcement） ----------

/** 诊断块 JSON 字节数（TextEncoder 全局，宿主与浏览器闭包两边都有；无则退化为字符数）。 */
export function diagByteLength(value: unknown): number {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const encoder = (globalThis as unknown as { TextEncoder?: new () => { encode(s: string): { length: number } } }).TextEncoder
    if (typeof encoder === 'function') return new encoder().encode(text ?? '').length
    return String(text ?? '').length
  } catch {
    try {
      return String(JSON.stringify(value) ?? '').length
    } catch {
      return 0
    }
  }
}

/**
 * 字节墙下永不丢的键：码 / 阶段 / 路由+方法（原子对，要么同有要么同省） / 请求编号
 * （及版本门 `v` 与 envelope 码）。这些键即使超预算也保留——丢了它们诊断即不可定位，
 * 不如超一点（实际仍能压进预算，见下）。
 * 路由与方法正交但原子：构造侧（diag.ts deriveRouteMethod）同产同省，墙侧若只保路由
 * 必拆散该对（对抗审查实锤：#21 超长中文用例 route 在 method 被省，well-formed 断言红）。
 * 方法串极短（https/fs/phone/spawn/service，约十字节），永保代价可忽略。
 */
export const DIAG_NEVER_DROP_KEYS = ['v', 'code', 'error', 'errorKind', 'stage', 'route', 'method', 'requestId'] as const

/**
 * 按序省的键（#24 票面顺序）：registryHost → action → 版本（latest → running → target 包名）
 * → 其余可选。尾段按诊断价值升序（先省最不定位的）：耗时（仅范围断言）→ 退出码（仅 exec 有）
 * → 环境（面板多已知）→ 检查编号（请求号已永保，join 一半冗余）
 * → HTTP 状态（429 信号最定位，最后省）。方法不在此列（与路由原子永保）。
 * 面板只渲染不推导，不靠顺序分支。
 * （对抗审查订正：旧尾段把 latency 放最后即最难省，与“仅范围断言”价值倒挂，已掉头；
 * 旧尾段含 method，已移入永保，理由见上。）
 */
export const DIAG_DROP_ORDER = [
  'registryHost',
  'action',
  'latestVersion',
  'runningVersion',
  'targetPackageName',
  'latencyMs',
  'exitCode',
  'environmentKind',
  'checkId',
  'httpStatus',
] as const

export type DiagDropKey = (typeof DIAG_DROP_ORDER)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * DIAG 字节墙 enforcement：输入任意 diag 候选对象，返回预算内的对象 + 显式 truncated 位。
 *
 * - 码/阶段/路由+方法（原子对）/请求编号（及 v）永不丢；
 * - detail 只截断不省（先按 300 字口径，再按需收窄，落刀不断占位符）；
 * - registryHost / action / 版本按 DIAG_DROP_ORDER 依次省；
 * - 显式 `truncated: true` 当且仅当本次动过 detail 或省过任一键（否则 false）。
 *
 * 纯函数、确定性：同一输入同一输出；不读盘、不联网、不抛错（坏输入回最小骨架）。
 */
export function enforceDiagBudget<T extends Record<string, unknown>>(input: T): T & { truncated: boolean } {
  const base: Record<string, unknown> = isRecord(input) ? { ...(input as Record<string, unknown>) } : {}
  const sizeOf = (obj: Record<string, unknown>): number => diagByteLength(obj)

  const convergeDetailTo300 = (obj: Record<string, unknown>): boolean => {
    const current = obj['detail']
    if (typeof current !== 'string' || !current) return false
    const next = truncateToWordBoundary(current, DETAIL_MAX_CHARS)
    if (next !== current) {
      obj['detail'] = next
      return true
    }
    return false
  }

  const shrinkDetailToFit = (obj: Record<string, unknown>): boolean => {
    const current = obj['detail']
    if (typeof current !== 'string' || !current) return false
    let next = current
    let changed = false
    while (next && sizeOf({ ...obj, detail: next, truncated: true }) > DIAG_INLINE_BUDGET_BYTES) {
      const shorter = next.length - 50
      if (shorter <= 0) {
        next = ''
        break
      }
      const cut = truncateToWordBoundary(next.slice(0, shorter), shorter) || next.slice(0, shorter) + '…'
      if (cut.length >= next.length) {
        next = next.slice(0, shorter) + '…'
      } else {
        next = cut
      }
      changed = true
    }
    if (next !== current) {
      obj['detail'] = next
      return true
    }
    return changed
  }

  // 初态：已在预算内即直接回（补显式位）。
  if (sizeOf({ ...base, truncated: (base['truncated'] as boolean) ?? false }) <= DIAG_INLINE_BUDGET_BYTES) {
    const already = base['truncated'] === true
    return { ...base, truncated: already } as T & { truncated: boolean }
  }

  const working: Record<string, unknown> = { ...base }
  // 票面顺序：detail 先收敛到 300 字口径（只一步，不直接缩到进墙），
  // 再按 DIAG_DROP_ORDER 省键；省完仍超才继续缩 detail（保定位键不丢）。
  // 能走到这里输入必超墙，返回 truncated 必为 true（显式位）；初态已在墙内早回 false。
  convergeDetailTo300(working)
  for (const key of DIAG_DROP_ORDER) {
    if (sizeOf({ ...working, truncated: true }) <= DIAG_INLINE_BUDGET_BYTES) break
    if (key in working) {
      delete working[key]
    }
  }
  // 省完仍超才走：继续收窄 detail，而不是动永不丢键。
  if (sizeOf({ ...working, truncated: true }) > DIAG_INLINE_BUDGET_BYTES && typeof working['detail'] === 'string' && working['detail']) {
    shrinkDetailToFit(working)
    if (sizeOf({ ...working, truncated: true }) > DIAG_INLINE_BUDGET_BYTES && typeof working['detail'] === 'string' && working['detail']) {
      working['detail'] = ''
    }
  }
  // 永不丢键原样保留（即使极端输入仍超，也不动它们——调用方宁可超一点也不丢定位）。
  for (const key of DIAG_NEVER_DROP_KEYS) {
    if (key in base && !(key in working)) working[key] = base[key]
  }
  return { ...working, truncated: true } as T & { truncated: boolean }
}
