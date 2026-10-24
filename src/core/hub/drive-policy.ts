// src/core/hub/drive-policy.ts —— 中枢推进策略：一轮推进循环停下之后，下一步该「让位、续跑、判定收尾还是报故障」。
//
// 第一性：推进循环的 fatal 后果不是「这一轮失败」，而是「序列停在中间、没人再动」。所以策略分四类：
//   - continue：预算用完/外部边界——必须再跑一轮（否则序列停在半路）；
//   - yield   ：队列里正在装别家 / 暂时排不上——不报错、不空转，等外部事件；
//   - settle  ：序列真的走完了——收尾；
//   - fail    ：驱动器自身出错或无进展太久——给出真相，别把序列挂死。
//
// 纪律：本文件零 IO、零钟表、零随机——调用方给事实，函数只给判决（可单测、可对抗审查）。

/** 一轮推进最多走多少步（批量目标再多也够；防「一次通话跑完历史所有债」）。 */
export const HUB_MAX_STEPS_PER_CYCLE = 2000

/** 连续多少步没有进展就判定故障（防同一目标无限重试把队列饿死）。 */
export const HUB_MAX_IDLE_STEPS = 10

/** 一轮推进之后中枢该做什么。 */
export type HubCycleVerdict =
  /** 预算用完或外部边界挡了一下：让位，等下一次事件再续。 */
  | 'continue'
  /** 队列里正在装别家 / 暂时轮不到：什么都不报，等事件。 */
  | 'yield'
  /** 序列已经真走完：收尾并释放属主。 */
  | 'settle'
  /** 驱动器自身出错或无进展太久：报故障，别把序列挂死。 */
  | 'fail'

/** 判定需要的事实：只读快照，不触碰会话本身。 */
export interface HubCycleFacts {
  /** 序列是否已走完（batchRunFinished 那套口径：全部行进终态）。 */
  sessionFinished: boolean
  /** 这一轮为什么停（BatchStoppedByBecause；未知值按故障算）。 */
  stoppedBecause: string
  /** 这一轮实际走了几步。 */
  stepsTaken: number
  /** 这一轮连续无进展的步数（同一目标反复排队、无相位变化）。 */
  consecutiveNoProgress: number
}

/** 预算上限（调用方可调小；超过内部防御上限按内部上限算）。 */
export interface HubDriveLimits {
  maxStepsPerCycle?: number
  maxIdleSteps?: number
}

/**
 * 给「这一轮停下之后」判一个明确动作。永不抛：
 * 预算/单调性越界按最保守的 fail 处理（宁可如实报故障，也不假装继续）。
 */
export function decideHubCycleVerdict(facts: HubCycleFacts, limits?: HubDriveLimits): HubCycleVerdict {
  try {
    if (!facts || typeof facts !== 'object') return 'fail'
    const maxSteps = normalizeLimit(limits?.maxStepsPerCycle, HUB_MAX_STEPS_PER_CYCLE, 100_000)
    const maxIdle = normalizeLimit(limits?.maxIdleSteps, HUB_MAX_IDLE_STEPS, 1_000)
    const steps = normalizeCount(facts.stepsTaken)
    const idle = normalizeCount(facts.consecutiveNoProgress)
    if (facts.sessionFinished === true) return 'settle'
    if (steps >= maxSteps) return 'fail'
    if (idle >= maxIdle) return 'fail'
    switch (facts.stoppedBecause) {
      case 'max-steps':
        return 'continue'
      case 'empty':
      case 'queued':
        return 'yield'
      case 'finished':
      case 'stopped-after-failure':
        return 'settle'
      case 'user-cancel':
      case 'error':
        return 'fail'
      default:
        return 'fail'
    }
  } catch {
    return 'fail'
  }
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < 1) return fallback
  return rounded > max ? max : rounded
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
