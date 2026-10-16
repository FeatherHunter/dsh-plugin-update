/**
 * src/install-cause.ts —— 安装失败翻译官（#155）：已知签名识别 + 诚实归因。
 *
 * 管道（四步，全纯函数；任何一步异常即回 null，调用方走通用老路，最坏情况就是现在）：
 *   认（签名表命中机器码）→ 抠（命名捕获取包名/版本/时间）→ 判（三值归因）→ 算（解封时间反推）
 *
 * 第一性边界（违反任何一条即本模块失格）：
 * - 只认"见过且有机器编码"的签名（首期仅 minimum-release-age 一行），其余一律认怂；
 * - 归因只排除、不定罪：能证明"不是主包"，证明不了"邻居还是传递依赖"——后者不说；
 * - 解封时间以报错自述为准：优先取报文里的窗口（publishedAt + N minutes），
 *   无窗口才用门限反推（publishedAt + (now - cutoff)），永不硬编码策略时长；
 * - 本模块零 I/O、零 Date.now（时间为入参）、零中文文案（人类语言一律走 bilingual 键）。
 *
 * 数据结构：签名是数据不是分支（新增签名 = 加一行表 + 两条测试，管道不动）；
 * 正则无嵌套量词、无 /g（.exec 无状态），KB 级输入线性收敛，无 ReDoS 面。
 */

export const CAUSE_KINDS = ['minimum-release-age'] as const
export type CauseKind = (typeof CAUSE_KINDS)[number]

/** 三值归因：主包自己 / 非主包（关系不明，只摘嫌疑）/ 未知（目标不明时，不排除）。 */
export type CauseBlame = 'target' | 'other-package' | 'unknown'

export interface CauseSignature {
  readonly kind: CauseKind
  /** 适用的稳定码（安装执行失败；其它码即使撞见同样文本也不认）。 */
  readonly codes: readonly string[]
  /** 适用的 diag 阶段（exec；调用方没给阶段即不设门）。 */
  readonly stages: readonly string[]
  /** 身份 token（字面包含即认，不定位置——安装器把码放头放尾版本间会变）。 */
  readonly token: string
  /** 事实抽取（命名组，无 /g，无嵌套量词；与 token 无关，顺序只锁"包→发布时间→门限"）。 */
  readonly pattern: RegExp
}

const CAUSE_SIGNATURES = [
  {
    kind: 'minimum-release-age',
    codes: ['install-failed'],
    stages: ['exec'],
    token: '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]',
    pattern:
      // 锚词故意放宽（published/cutoff 只认词不认整句）：安装器措辞版本间会变，
      // 身份由 token 承担；时间只认 ISO 形，Date.parse 再验；双界 120 字符防跨段乱抠。
      /(?<spec>@?[a-z0-9][a-z0-9._/-]*@[0-9][A-Za-z0-9._-]*)[\s\S]*?published[\s\S]{0,120}?(?<published>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z?)[\s\S]*?cutoff[\s\S]{0,120}?(?<cutoff>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z?)/,
  },
] as const satisfies readonly CauseSignature[]

export interface InterpretCauseInput {
  readonly errorCode: string
  readonly stage?: string
  readonly detail?: unknown
  readonly targetPackageName?: unknown
  /** 调用方时钟（毫秒 epoch）；不给即 Date.now（生产），测试必传。 */
  readonly nowMs?: number
}

export interface CauseFacts {
  readonly kind: CauseKind
  /** 显示用完整规格（如 dshmarket@1.66.28；归因比对时剥版本）。 */
  readonly spec: string
  readonly packageName: string
  readonly packageVersion: string | null
  readonly publishedAtMs: number | null
  readonly cutoffMs: number | null
  /**
   * 报文自述的策略窗口（分钟；如 "less than 1440 minutes ago"）。
   * null = 报文没说或数字离谱，调用方改用门限反推——照样不硬编码。
   */
  readonly windowMinutes: number | null
  /** 解封时刻（毫秒；算不出或已过即省略，调用方只给无时间版文案）。 */
  readonly unlockAtMs?: number
  readonly blame: CauseBlame
}

function toMs(value: unknown): number | null {
  try {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string' && value.trim()) {
      const ms = Date.parse(value.trim())
      if (Number.isFinite(ms) && ms > 0) return ms
    }
  } catch {
    /* 坏时间即未知，不抛 */
  }
  return null
}

/** 规格剥版本：最后一个 @ 之后是版本（@0 位的是 scope 头，不剥）。 */
export function causePackageNameOf(spec: unknown): string {
  try {
    const s = String(spec ?? '').trim()
    if (!s) return ''
    const at = s.lastIndexOf('@')
    if (at > 0) return s.slice(0, at)
    return s
  } catch {
    return ''
  }
}

export function blameCausePackage(spec: unknown, targetPackageName: unknown): CauseBlame {
  try {
    const name = causePackageNameOf(spec)
    const target = String(targetPackageName ?? '').trim()
    if (!name || !target) return 'unknown'
    if (name === target) return 'target'
    if (name.toLowerCase() === target.toLowerCase()) return 'target'
    return 'other-package'
  } catch {
    return 'unknown'
  }
}

/** 解封时刻 → 本地短时间（zh：10月17日 13:58；en：Oct 17, 01:58 PM）；非法回 null。 */
export function formatUnlockAt(ms: unknown, lang?: string): string | null {
  try {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
    const tag = String(lang ?? '').trim().toLowerCase()
    const locale = tag.startsWith('en') ? 'en-US' : 'zh-CN'
    const text = new Intl.DateTimeFormat(locale, {
      month: locale === 'en-US' ? 'short' : 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: locale === 'en-US',
    }).format(ms)
    return text && text.trim() ? text.trim() : null
  } catch {
    return null
  }
}

/**
 * 策略窗口自述（独立正则，不跟事实 pattern 锁顺序——顺序坑吃过一次就够了）：
 * 只认"less than N minutes ago"，N 为 1~7 位数字；单位只认分钟（小时/天没见过，
 * 见到了走回退，不猜）。 sanity 上限十年（分钟），超了当没说。
 */
const WINDOW_PATTERN = /less than (?<windowMinutes>[0-9]{1,7}) minutes? ago/
const WINDOW_MINUTES_MAX = 525600 * 10

function parseWindowMinutes(detail: string): number | null {
  try {
    const matched = WINDOW_PATTERN.exec(detail)
    if (!matched?.groups) return null
    const n = Number(matched.groups['windowMinutes'])
    if (!Number.isInteger(n) || n <= 0 || n > WINDOW_MINUTES_MAX) return null
    return n
  } catch {
    return null
  }
}

export function interpretInstallCause(input: InterpretCauseInput): CauseFacts | null {
  try {
    const errorCode = String(input?.errorCode ?? '')
    const detail = input?.detail
    if (!errorCode || typeof detail !== 'string' || !detail.trim()) return null
    const nowMs = toMs(input?.nowMs) ?? Date.now()
    for (const sig of CAUSE_SIGNATURES) {
      // 常量表字面量窄化后的 includes 不吃 string：此处显式放宽（表只增不改，门由测试锁）。
      const codes: readonly string[] = sig.codes
      const stages: readonly string[] = sig.stages
      if (!codes.includes(errorCode)) continue
      if (stages.length > 0 && typeof input?.stage === 'string' && input.stage) {
        if (!stages.includes(input.stage)) continue
      }
      // 身份与事实分两步：token 定"是哪种错"（位置不限），pattern 抠"错在哪"。
      if (!detail.includes(sig.token)) continue
      const matched = sig.pattern.exec(detail)
      if (!matched || !matched.groups) continue
      const spec = String(matched.groups['spec'] ?? '').trim()
      if (!spec) continue
      const publishedAtMs = matched.groups['published'] ? toMs(matched.groups['published']) : null
      const cutoffMs = matched.groups['cutoff'] ? toMs(matched.groups['cutoff']) : null
      // 解封时刻（优先级即诚实度排序）：
      // 1) 报文自述窗口：unlock = published + N minutes（安装器自己说的，最准）；
      // 2) 无窗口才门限反推：unlock = published + (now - cutoff)
      //    （假设 cutoff = 评估时刻 - 策略窗；评估与调用有时差，结果偏晚——偏晚是安全方向）；
      // 3) 都算不出，或算出来已过：省略，不给假时间/过去的时间。
      const windowMinutes = parseWindowMinutes(detail)
      let unlockAtMs: number | undefined
      if (publishedAtMs !== null && windowMinutes !== null) {
        const unlock = publishedAtMs + windowMinutes * 60_000
        if (unlock > nowMs) unlockAtMs = unlock
      } else if (publishedAtMs !== null && cutoffMs !== null) {
        const windowMs = nowMs - cutoffMs
        const unlock = publishedAtMs + windowMs
        if (windowMs > 0 && unlock > nowMs) unlockAtMs = unlock
      }
      const at = spec.lastIndexOf('@')
      return {
        kind: sig.kind,
        spec,
        packageName: causePackageNameOf(spec),
        packageVersion: at > 0 ? spec.slice(at + 1) || null : null,
        publishedAtMs,
        cutoffMs,
        windowMinutes,
        ...(unlockAtMs !== undefined ? { unlockAtMs } : {}),
        blame: blameCausePackage(spec, input?.targetPackageName),
      }
    }
    return null
  } catch {
    return null
  }
}

export interface CauseInterpreterCounts {
  recognized: Record<string, number>
  unrecognized: number
}

/**
 * 计数解释器（#155 未识别签名统计口：指导下一种签名先做哪个）。
 * 解释仍走纯函数，本体只做计数；测试用 createCauseInterpreter() 拿隔离实例。
 */
export function createCauseInterpreter(): {
  interpret: (input: InterpretCauseInput) => CauseFacts | null
  counts: () => CauseInterpreterCounts
} {
  const recognized: Record<string, number> = {}
  let unrecognized = 0
  return {
    interpret(input: InterpretCauseInput): CauseFacts | null {
      try {
        const out = interpretInstallCause(input)
        if (out) recognized[out.kind] = (recognized[out.kind] ?? 0) + 1
        else unrecognized += 1
        return out
      } catch {
        unrecognized += 1
        return null
      }
    },
    counts(): CauseInterpreterCounts {
      return { recognized: { ...recognized }, unrecognized }
    },
  }
}

/** 进程内单例（生产代码走它；测试走纯函数或自建实例，不碰单例状态）。 */
export const causeInterpreter = createCauseInterpreter()

export function causeInterpreterCounts(): CauseInterpreterCounts {
  return causeInterpreter.counts()
}
