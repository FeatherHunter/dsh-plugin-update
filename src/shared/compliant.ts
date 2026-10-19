/**
 * src/shared/compliant.ts —— 合规版决议（#156）：年龄门拦住时，找"满门限的最新版"。
 *
 * 纯函数：零 I/O、零 Date.now（时间为入参）、零中文文案（人类语言一律走 bilingual 键）。
 * 自包含（与 src/shared/commands.ts 同纪律）：版本号小工具按需内联，不引用同层其它文件的
 * 运行时逻辑，只用 import type 取类型——service 与本模块互不导入，无循环。
 *
 * 五裁决（互斥，卫语句顺序即优先级）：
 *   ok-now —— 最新版已满门限（现在装就行，重试即可）；
 *   wait-until —— 最新版未满、无老版合规（只给时间，不编版本）；
 *   downgrade-available —— 最新版未满、有老版合规（给候选 + 目标解封）；
 *   no-compliant —— 窗口已知但目标解封算不出、又无老版合规（不等同于 wait）；
 *   abstain —— 输入不可用（归因非主包 / 未知 kind / 无窗口 / 无时间表 / 目标非 latest /
 *     通道不收目标），调用方走通用老路，最坏情况就是现在。
 *
 * 第一性边界（违反任何一条即本模块失格）：
 * - 窗口只读输入（报文自述或调用方反推），本模块永不硬编码策略时长；
 * - 候选三锁：发行形状合法 + 本通道接受 + 严格新于运行版（三者缺一即跳过，不产降级安装）；
 * - 时间只认毫秒数：表项坏掉（null/负数/非数字/NaN）即忽略该条，不整表作废；
 * - 最新发布时间 registry 表优先、报文时间为 fallback；目标解封算不出即给 null，不编时间；
 * - windowSource 原样回传：精确与约的区分是呈现层的事，本层照样决议。
 */

import type { ReleaseChannel } from './ports.js'

/** 本模块认识的 kind（首期仅 minimum-release-age；新增 = 加一行 + 两条测试，管道不动）。 */
const COMPLIANT_KINDS = ['minimum-release-age'] as const

// 类型已上收 ports（#165 断 ports⇄compliant-version 纯类型环）：本模块只留值实现，
// 对外脸经垫片不变（tests 深引用 ../dist/compliant-version.js 与包根转出口零碰）。
import type { CompliantVerdict, CompliantVersionInput, CompliantWindowSource } from './ports.js'
export type { CompliantVerdict, CompliantVersionInput, CompliantWindowSource } from './ports.js'

// ---------- 版本号小工具（与 src/core/service.ts 同口径的内联版，本文件自包含） ----------

function isTriple(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v)
}

function validPrereleaseIds(ids: string): boolean {
  if (!ids) return false
  const parts = ids.split('.')
  if (parts.length === 0) return false
  for (const p of parts) {
    if (!p || !/^[0-9A-Za-z-]+$/.test(p)) return false
    if (/^\d+$/.test(p) && p.length > 1 && p.startsWith('0')) return false
  }
  return true
}

function validReleaseVersion(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false
  const dash = v.indexOf('-')
  if (dash < 0) return isTriple(v)
  const core = v.slice(0, dash)
  const ids = v.slice(dash + 1)
  if (!isTriple(core) || !validPrereleaseIds(ids)) return false
  if (ids.includes('+')) return false
  return true
}

function allowedInChannel(version: string, channel: ReleaseChannel): boolean {
  if (channel === 'prerelease') return validReleaseVersion(version)
  return isTriple(version)
}

function parseTriple(v: string): [number, number, number] | null {
  const parts = v.split('.')
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

function compareRelease(a: string, b: string): -1 | 0 | 1 {
  const dashA = a.indexOf('-')
  const dashB = b.indexOf('-')
  const coreA = dashA < 0 ? a : a.slice(0, dashA)
  const coreB = dashB < 0 ? b : b.slice(0, dashB)
  const pa = parseTriple(coreA)
  const pb = parseTriple(coreB)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  const preA = dashA < 0 ? null : a.slice(dashA + 1).split('.')
  const preB = dashB < 0 ? null : b.slice(dashB + 1).split('.')
  if (preA === null && preB === null) return 0
  if (preA === null) return 1
  if (preB === null) return -1
  const width = Math.max(preA.length, preB.length)
  for (let i = 0; i < width; i++) {
    const x = preA[i]
    const y = preB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x) ? Number(x) : null
    const yn = /^\d+$/.test(y) ? Number(y) : null
    if (xn !== null && yn !== null) {
      if (xn < yn) return -1
      if (xn > yn) return 1
      continue
    }
    if (xn !== null) return -1
    if (yn !== null) return 1
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

// ---------- 决议 ----------

function toMs(value: unknown): number | null {
  try {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  } catch {
    /* 坏时间即未知，不抛 */
  }
  return null
}

function sourceOf(value: unknown): CompliantWindowSource {
  return value === 'message' || value === 'host' || value === 'unknown' ? value : 'unknown'
}

/**
 * 合规版决议：输入全是只读事实，输出五裁决之一。任何一步输入不可用即 abstain，
 * 调用方走通用老路。永不抛（调用方是面板/核心渲染链，抛了就是白屏）。
 */
export function resolveCompliantVersion(input: CompliantVersionInput): CompliantVerdict {
  try {
    const windowSource = sourceOf(input?.windowSource)
    const abstain = (reason: string): CompliantVerdict => ({ kind: 'abstain', reason, windowSource })
    const kinds: readonly string[] = COMPLIANT_KINDS
    if (!kinds.includes(String(input?.kind ?? ''))) return abstain('unknown-kind')
    if (input?.blame !== 'target') return abstain('not-target')
    const channel: ReleaseChannel = input?.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
    const target = typeof input?.targetVersion === 'string' ? input.targetVersion : ''
    const latest = typeof input?.latestVersion === 'string' ? input.latestVersion : ''
    const running = typeof input?.runningVersion === 'string' ? input.runningVersion : ''
    if (!target || !latest || !running) return abstain('bad-input')
    // 本模型只覆盖"被拦的恰好是最新版"；拦的是老版（用户自选旧版等）不在模型内。
    if (target !== latest) return abstain('target-not-latest')
    if (!allowedInChannel(latest, channel)) return abstain('target-channel')
    const windowMs = toMs(input?.windowMs)
    if (windowMs === null) return abstain('unknown-window')
    const nowMs = toMs(input?.nowMs)
    if (nowMs === null) return abstain('bad-now')
    const table = input?.timeTable
    if (!table || typeof table !== 'object') return abstain('no-timetable')
    // 最新发布时间：registry 表优先，报文时间为 fallback；都没有即未知。
    const latestPublished = toMs((table as Record<string, unknown>)[latest]) ?? toMs(input?.publishedAtMs)
    // 连评都评不了：目标发布时间未知、且表里没有任何可用发布时间
    //（空表或全是坏条目）→ abstain，不是 no-compliant。
    let anyUsableTime = latestPublished !== null
    if (!anyUsableTime) {
      try {
        for (const v of Object.keys(table)) {
          if (toMs((table as Record<string, unknown>)[v]) !== null) {
            anyUsableTime = true
            break
          }
        }
      } catch {
        /* 读表坏了即无可用时间 */
      }
    }
    if (!anyUsableTime) return abstain('no-timetable')
    const latestUnlock = latestPublished === null ? null : latestPublished + windowMs
    // 最新版已满门限：现在装就行。
    if (latestUnlock !== null && latestUnlock <= nowMs) {
      return { kind: 'ok-now', version: latest, unlockAtMs: latestUnlock, windowSource }
    }
    // 从新到旧找首个合规老版：形状合法 + 通道接受 + 严格新于运行版 + 满门限。
    let candidate: string | null = null
    try {
      const versions = Object.keys(table).filter(
        (v) => validReleaseVersion(v) && allowedInChannel(v, channel) && compareRelease(v, latest) < 0,
      )
      versions.sort((a, b) => compareRelease(b, a))
      for (const v of versions) {
        if (compareRelease(v, running) !== 1) continue
        const published = toMs((table as Record<string, unknown>)[v])
        if (published === null) continue
        if (published + windowMs <= nowMs) {
          candidate = v
          break
        }
      }
    } catch {
      candidate = null
    }
    if (candidate !== null) {
      return {
        kind: 'downgrade-available',
        version: candidate,
        targetVersion: latest,
        targetUnlockAtMs: latestUnlock !== null && latestUnlock > nowMs ? latestUnlock : null,
        windowSource,
      }
    }
    // 无老版合规：目标解封算得出即等，不算不出即如实报告无合规。
    if (latestUnlock !== null && latestUnlock > nowMs) {
      return { kind: 'wait-until', version: latest, unlockAtMs: latestUnlock, windowSource }
    }
    return { kind: 'no-compliant', version: latest, windowSource }
  } catch {
    return { kind: 'abstain', reason: 'internal', windowSource: 'unknown' }
  }
}
