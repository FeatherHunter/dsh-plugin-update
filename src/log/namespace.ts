/**
 * src/log/namespace.ts —— 插件标识 → 日志命名空间（目录名与开关文件名的那一半）。
 *
 * 为什么需要派生：dsh-log 只收 `[a-z0-9-]{1,32}` 形状的 pluginId，**收到大写直接抛**；
 * 而本包允许集成方用 `My.Plugin` 这类标识（`src/shared/config.ts` 的 assertPluginId 只管路径分隔符与 NUL）。
 * 只做小写化会让 `My.Plugin` 与 `my-plugin` 撞成同一棵日志目录 —— 那正是本需求要消灭的
 * 「同一目录两个写者、日志互相覆盖」；所以凡发生有损映射或截断，补一段 raw 的 sha256 指纹。
 *
 * 不变量（tests/log-kernel.test.mjs 逐条钉住）：
 *   1. 已经是合法命名空间的 id **原样通过**（集成方拿到的目录名与它自己写的标识一致）；
 *   2. 无损分支（原样通过）下不同 raw 标识**永不**派生出同一个名字；有损分支（空格/点/大写/超长/中文/空串）
 *      靠 24 位 sha256 指纹区分，属**概率性**隔离——同一 24 位 slug 前缀的有损标识足够多时理论上可撞名；
 *   3. 返回值恒满足 dsh-log 的 pluginId 形状（小写字母数字连字符，1..32）。
 *
 * 本文件只做字符串与哈希，不碰文件系统：目录建与不建是 dsh-log 的事。
 */
import { createHash } from 'node:crypto'

/** dsh-log 收得下的 pluginId 形状（`dist/config/resolve.js` 的校验口径）。 */
const NAMESPACE_SHAPE = /^[a-z0-9-]{1,32}$/
/** 派生命名空间的总长上限（与 NAMESPACE_SHAPE 同口径）。 */
const MAX_CHARS = 32
/** 有损分支里 slug 最多留几个字符，给 `-` 与 6 位指纹腾位置（24 + 1 + 6 = 31 ≤ 32）。 */
const SLUG_CHARS = 24
/** 有损分支的指纹位数。 */
const HASH_CHARS = 6
/** slug 被完全吃掉时的兜底前缀（空串、纯符号、纯中文都会走到这里）。 */
const FALLBACK_SLUG = 'plugin'
/** 目录身份键里判定「这是 Windows 路径」的形状（盘符或 UNC），避免在 POSIX 上误小写化。 */
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]|^\\\\/

/**
 * 稳定短指纹：sha256 前 n 位十六进制。
 * 为什么用 sha256 而不是本包别处的 djb2 hash8：命名空间要跨进程、跨副本、跨版本稳定，
 * 且必须抗「两个不同标识撞同一个后缀」；djb2 在 6 位十六进制下碰撞概率不可接受。
 * 绝不抛：拿不到 node:crypto（异常运行环境）时退回 djb2 实现，仍保证稳定与长度。
 */
export function hashToken(text: unknown, chars = 8): string {
  const raw = String(text ?? '')
  const want = Number.isFinite(chars) ? Math.max(1, Math.min(64, Math.floor(chars))) : 8
  try {
    return createHash('sha256').update(raw).digest('hex').slice(0, want)
  } catch {
    return djb2Hex(raw, want)
  }
}

/** 无 node:crypto 时的兜底指纹（与 sha256 同样稳定、同样定长，只是抗碰撞弱一档）。 */
function djb2Hex(text: string, chars: number): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  let out = ''
  let seed = h
  while (out.length < chars) {
    seed = ((seed << 5) + seed + 0x9e3779b9) >>> 0
    out += seed.toString(16).padStart(8, '0')
  }
  return out.slice(0, chars)
}

/**
 * 插件标识 → 命名空间。集成方拿到的目录名、开关文件名、dsh-log 的 pluginId 全用它。
 * 只取第一个入参的真值字符串形态；非法类型按空串处理（不抛，接线层负责记 selfmon 行）。
 */
export function deriveLogNamespace(rawPluginId: unknown): string {
  const raw = typeof rawPluginId === 'string' ? rawPluginId.trim() : ''
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  // 无损且合法：原样通过（这是集成方最常见的情形，也是「目录名=我写的标识」的保证）。
  if (slug && slug === raw && NAMESPACE_SHAPE.test(slug)) return slug
  const base = slug.slice(0, SLUG_CHARS).replace(/-+$/g, '') || FALLBACK_SLUG
  const derived = `${base}-${hashToken(raw, HASH_CHARS)}`
  return NAMESPACE_SHAPE.test(derived) ? derived : `${FALLBACK_SLUG}-${hashToken(raw, HASH_CHARS)}`
}

/**
 * 目录身份键：登记表（同一目录只许一个句柄）用的 Map 键。
 * Windows 下大小写不敏感（`Logs` 与 `logs` 是同一个目录），必须折叠，否则同一目录会拿到两个句柄，
 * 两个写者又回来了；POSIX 下大小写敏感，不能乱折叠。
 */
export function logDirKey(dirPath: unknown): string {
  const path = String(dirPath ?? '').replace(/[\\/]+$/, '')
  return WINDOWS_PATH.test(path) ? path.toLowerCase() : path
}

/** 开关文件名：`wf` 是 dsh-log 的保留命名空间（默认 `log-switch.json`），其余一律带命名空间后缀。 */
export function logSwitchFileName(namespace: string): string {
  return namespace === 'wf' ? 'log-switch.json' : `log-switch-${namespace}.json`
}

/** 命名空间长度上限的只读出口（给文档与测试对齐口径，避免各处写死 32）。 */
export const LOG_NAMESPACE_MAX_CHARS = MAX_CHARS
