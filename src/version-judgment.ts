/**
 * src/version-judgment.ts —— 版本判定核（#165 第二刀：从 service.ts 独立）。
 *
 * 纯函数：版本号合法性、通道、比较、Node 范围判定，外加判定失败抛的码错工厂。
 * 零导入（只有 type 进 ports 取 UpdateErrorCode，运行时无边，天然叶子）。
 * 老位置（service.ts）留垫片 re-export，测试深引用与包导出表零碰。
 */

import type { ReleaseChannel, UpdateErrorCode } from './ports.js'

export function updateError(code: UpdateErrorCode): Error & { code: UpdateErrorCode } {
  return Object.assign(new Error(code), { code })
}

// ---------- 版本号小工具（只认纯数字三段，预发布一律拒绝） ----------
// 冻结语：validVersion / compareVersions 的行为保持现状（stable 通道默认值），
// 预发布识别走下面新增的 release 版小工具（#16，加法扩展，不改旧行为）。

export function validVersion(v: unknown): v is string {
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)
}

/** 版本通道：默认只推 stable；prerelease 须调用方显式 opt-in（#16）。
 * 正典在 ports（#165 评审收敛：同一 union 不立两处，避免静默分叉）。 */
export type { ReleaseChannel }
export const RELEASE_CHANNELS = ['stable', 'prerelease'] as const

export function validReleaseChannel(v: unknown): v is ReleaseChannel {
  return v === 'stable' || v === 'prerelease'
}

/** 预发布标识符是否合法（SemVer §9：点分字母数字与连字符，非空、不留空段）。 */
function validPrereleaseIds(ids: string): boolean {
  if (typeof ids !== 'string' || !ids) return false
  const parts = ids.split('.')
  if (parts.length === 0) return false
  for (const p of parts) {
    if (!p || !/^[0-9A-Za-z-]+$/.test(p)) return false
    if (/^\d+$/.test(p) && p.length > 1 && p.startsWith('0')) return false
  }
  return true
}

/**
 * 发行版本号（含预发布）：`X.Y.Z` 或 `X.Y.Z-ids`（ids 见 SemVer §9）。
 * stable 版（纯三段）恒为真；`0.2.0-rc.2` 这类预发布在此为真、在 validVersion 为假。
 */
export function validReleaseVersion(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false
  const dash = v.indexOf('-')
  if (dash < 0) return validVersion(v)
  const core = v.slice(0, dash)
  const ids = v.slice(dash + 1)
  if (!validVersion(core) || !validPrereleaseIds(ids)) return false
  // 构建元数据（`+build`）不参与版本比较，本包不接受：含 `+` 一律拒绝。
  if (ids.includes('+')) return false
  return true
}

/** 是否预发布版本（发行合法但非纯三段）。 */
export function isPrereleaseVersion(v: unknown): v is string {
  return validReleaseVersion(v) && !validVersion(v)
}

/** 该版本在该通道是否允许出现：stable 通道只收纯三段，prerelease 通道两者皆收。 */
export function isVersionAllowedInChannel(version: unknown, channel: ReleaseChannel = 'stable'): version is string {
  if (channel === 'prerelease') return validReleaseVersion(version)
  return validVersion(version)
}

function parseTriple(v: string): [number, number, number] | null {
  const parts = String(v).split('.')
  if (parts.length > 3) return null
  const nums: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    const n = Number(p)
    if (!Number.isSafeInteger(n)) return null
    nums.push(n)
  }
  while (nums.length < 3) nums.push(0)
  return [nums[0], nums[1], nums[2]]
}

/** -1 更小，0 相等，1 更大（入参须先过 validVersion 或 parseTriple）。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseTriple(a)
  const pb = parseTriple(b)
  if (!pa || !pb) throw updateError('invalid-release')
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

function parseReleaseIds(ids: string): (number | string)[] {
  return ids.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
}

/**
 * 发行版比较（SemVer §11）：先比三段数字；三段相等时，无预发布 > 有预发布；
 * 都有预发布则按标识符逐个比（纯数字按数字比、数字 < 字母、段多者大）。
 * 入参须先过 validReleaseVersion，否则抛 invalid-release。
 */
export function compareReleaseVersions(a: string, b: string): -1 | 0 | 1 {
  if (!validReleaseVersion(a) || !validReleaseVersion(b)) throw updateError('invalid-release')
  const dashA = String(a).indexOf('-')
  const dashB = String(b).indexOf('-')
  const coreA = dashA < 0 ? String(a) : String(a).slice(0, dashA)
  const coreB = dashB < 0 ? String(b) : String(b).slice(0, dashB)
  const order = compareVersions(coreA, coreB)
  if (order !== 0) return order
  const preA = dashA < 0 ? null : parseReleaseIds(String(a).slice(dashA + 1))
  const preB = dashB < 0 ? null : parseReleaseIds(String(b).slice(dashB + 1))
  if (preA === null && preB === null) return 0
  if (preA === null) return 1
  if (preB === null) return -1
  const width = Math.max(preA.length, preB.length)
  for (let i = 0; i < width; i++) {
    const x = preA[i]
    const y = preB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x < y) return -1
      if (x > y) return 1
      continue
    }
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

function compareOne(node: [number, number, number], op: string, target: [number, number, number]): boolean {
  const order = compareTriple(node, target)
  if (op === '=' || op === '') return order === 0
  if (op === '>') return order === 1
  if (op === '>=') return order >= 0
  if (op === '<') return order === -1
  if (op === '<=') return order <= 0
  return true
}

function compareTriple(a: [number, number, number], b: [number, number, number]): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

function upperBound(t: [number, number, number], kind: '^' | '~', kept: number): [number, number, number] {
  if (kind === '^') {
    if (kept >= 1) return [t[0] + 1, 0, 0]
    return [0, t[1] + 1, 0]
  }
  if (kept >= 2) return [t[0], t[1] + 1, 0]
  return [t[0] + 1, 0, 0]
}

/**
 * caret 的上界要按 npm 语义处理 0.x：`^0.2.0` = `>=0.2.0 <0.3.0`、`^0.0.3` = `>=0.0.3 <0.0.4`。
 * （Node 运行时不会出现 0.x，故只给 DSH 判定用；`satisfiesNodeRange` 的既有语义不动。）
 */
function upperBoundRelease(t: [number, number, number], kind: '^' | '~'): [number, number, number] {
  if (kind === '~') {
    return t[0] > 0 || t[1] > 0 ? [t[0], t[1] + 1, 0] : [0, 0, t[2] + 1]
  }
  if (t[0] > 0) return [t[0] + 1, 0, 0]
  if (t[1] > 0) return [0, t[1] + 1, 0]
  return [0, 0, t[2] + 1]
}

/**
 * 运行环境是否满足远端要求的 Node 范围。
 * 只看懂星号、精确版与 ^ ~ > >= < <= 比较式；看不懂的写法一律放行不误拦。
 */
export function satisfiesNodeRange(nodeVersion: string, range: string | undefined): boolean {
  if (range === undefined || range === null) return true
  const text = String(range).trim()
  if (text === '' || text === '*') return true
  const node = parseTriple(String(nodeVersion).replace(/^v/, ''))
  if (!node) return true
  if (text.includes('||')) return true
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return true
  for (const part of parts) {
    const m = part.match(/^(\^|~|>=|<=|>|<|=)?(.+)$/)
    if (!m) return true
    const op = m[1] || ''
    const target = parseTriple(m[2])
    if (!target) return true
    if (op === '^' || op === '~') {
      const kept = m[2].split('.').length
      if (compareTriple(node, target) < 0) return false
      if (compareTriple(node, upperBound(target, op, kept)) >= 0) return false
      continue
    }
    if (!compareOne(node, op, target)) return false
  }
  return true
}

/**
 * 运行中的 DSH 是否满足远端声明的 DSH 范围（#195，取自 metadata 的 `engines.dsh`）。
 *
 * 与 Node 判定同一条宽松原则：看不懂的写法一律放行不误拦。但这里按**发行版**语义比较，
 * 能处理 `>=0.2.0-rc.2` 这类带预发布的目标（Node 运行时不会出现预发布，故不复用
 * `satisfiesNodeRange`——它的 parseTriple 会把预发布目标当看不懂而放行）。
 *
 * `dshVersion` 未知（null/空串/非法）时返回 true：不知道当前 DSH 版本就不许替用户判不兼容。
 */
export function satisfiesDshRange(dshVersion: string | null | undefined, range: string | undefined | null): boolean {
  if (range === undefined || range === null) return true
  const text = String(range).trim()
  if (text === '' || text === '*') return true
  const current = typeof dshVersion === 'string' ? dshVersion.trim() : ''
  if (!current || !validReleaseVersion(current)) return true
  if (text.includes('||')) {
    return text
      .split('||')
      .map((part) => part.trim())
      .filter(Boolean)
      .some((part) => satisfiesDshRange(current, part))
  }
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return true
  for (const part of parts) {
    const m = part.match(/^(\^|~|>=|<=|>|<|=)?(.+)$/)
    if (!m) return true
    const op = m[1] || ''
    const target = m[2]
    if (!validReleaseVersion(target)) return true
    const order = compareReleaseVersions(current, target)
    if (op === '^' || op === '~') {
      const core = target.split('-')[0]
      const triple = parseTriple(core)
      if (!triple) return true
      if (order < 0) return false
      const bound = upperBoundRelease(triple, op).join('.')
      if (compareReleaseVersions(current, bound) >= 0) return false
      continue
    }
    if (op === '=' || op === '') {
      if (order !== 0) return false
      continue
    }
    if (op === '>') {
      if (order !== 1) return false
      continue
    }
    if (op === '>=') {
      if (order < 0) return false
      continue
    }
    if (op === '<') {
      if (order !== -1) return false
      continue
    }
    if (op === '<=') {
      if (order > 0) return false
      continue
    }
  }
  return true
}
