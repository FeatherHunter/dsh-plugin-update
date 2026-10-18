/**
 * src/install-fail.ts —— 安装失败原因的分类器与日志字段收敛（#207 / 审查 S1-1）。
 *
 * 为什么单独一个中立文件：原因分类在四处产生（核心闸门、装后校验、三条执行路由），
 * 但只有 Node 侧的执行器知道「超时/崩溃/非零退出/起进程失败/终止失败」这些现场事实。
 * 中立文件只放稳定枚举与形状收敛，不 import `node:`，服务与存储两侧共用。
 *
 * ADR-0006 纪律：行里只放枚举值与派生量。宿主原话不进日志（只在失败详情的既有 message
 * 通道给面板/诊断副本）；hostCode 只收「宿主给的稳定码」形状的短标识，其余一律 `none`。
 */

/** 一次安装失败发生在哪个阶段：装前闸门 / 执行 / 装后校验。 */
export const INSTALL_FAIL_STAGES = ['gate', 'exec', 'verify'] as const
export type InstallFailStage = (typeof INSTALL_FAIL_STAGES)[number]

/**
 * 失败原因（十二值）。前六个是执行现场事实，中间三个是装后校验事实，
 * 后三个是装前闸门与兜底；取值可增（ADR-0006：枚举扩展向后兼容）。
 */
export const INSTALL_FAIL_REASONS = [
  'host-rejected',
  'timeout',
  'crashed',
  'nonzero-exit',
  'spawn-failed',
  'terminate-failed',
  'version-mismatch',
  'not-registered',
  'env-blocked',
  'noop',
  'gate-refused',
  'unknown',
] as const
export type InstallFailReason = (typeof INSTALL_FAIL_REASONS)[number]

/** 装后校验的子检查（exec/gate 阶段恒为 none；check 与 stage 正交）。 */
export const INSTALL_FAIL_CHECKS = ['version', 'registered', 'env', 'none'] as const
export type InstallFailCheck = (typeof INSTALL_FAIL_CHECKS)[number]

/** 执行器/校验器挂在抛错上的失败事实（不上电话、不落盘，只供服务侧记一行）。 */
export interface InstallFailFacts {
  stage: InstallFailStage
  reason: InstallFailReason
  /** 宿主给的稳定码（如 already-installed / bundle-in-use）；没有即 `none`。 */
  hostCode: string
  check: InstallFailCheck
  exitCode: number | null
}

/** 落一行所需的全部字段（服务侧补齐意图哈希与可观测事实）。 */
export interface InstallFailObservation extends InstallFailFacts {
  intentHash: string
  observedVersion: string | null
  pendingRestart: boolean
}

const FACT_KEY = 'installFail'
const HOST_CODE_RE = /^[a-z][a-z0-9-]{0,31}$/

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** 宿主码只收稳定码形状；路径/URL/冻结文案一律收敛成 `none`（负向断言的安全边界）。 */
export function normalizeHostCode(value: unknown): string {
  return typeof value === 'string' && HOST_CODE_RE.test(value) ? value : 'none'
}

/** 读抛错上附带的失败事实（执行器/校验器写的；形状不对一律当没有）。 */
export function readInstallFail(error: unknown): InstallFailFacts | null {
  try {
    const raw = (error as Record<string, unknown> | null | undefined)?.[FACT_KEY]
    if (!raw || typeof raw !== 'object') return null
    const facts = raw as Record<string, unknown>
    if (!isOneOf(INSTALL_FAIL_STAGES, facts['stage'])) return null
    if (!isOneOf(INSTALL_FAIL_REASONS, facts['reason'])) return null
    if (!isOneOf(INSTALL_FAIL_CHECKS, facts['check'])) return null
    const exitCode = typeof facts['exitCode'] === 'number' && Number.isInteger(facts['exitCode']) ? facts['exitCode'] : null
    return {
      stage: facts['stage'],
      reason: facts['reason'],
      hostCode: normalizeHostCode(facts['hostCode']),
      check: facts['check'],
      exitCode,
    }
  } catch {
    return null
  }
}

/**
 * 把失败事实挂在抛错上（不改变错误码/消息/既有 detail 形状）。
 * 用不可枚举属性：既有 `keysOf(error)` 式断言与 JSON 化都不受影响。
 */
export function attachInstallFail<T extends object>(error: T, facts: InstallFailFacts): T {
  try {
    Object.defineProperty(error, FACT_KEY, {
      value: {
        stage: facts.stage,
        reason: facts.reason,
        hostCode: normalizeHostCode(facts.hostCode),
        check: facts.check,
        exitCode: typeof facts.exitCode === 'number' && Number.isInteger(facts.exitCode) ? facts.exitCode : null,
      },
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } catch {
    /* 挂不上事实也绝不能挡安装路径 */
  }
  return error
}

/** 失败行的字段（固定八格；观测不到的值如实写 null/false，不省字段）。 */
export function installFailRowFields(observation: InstallFailObservation): Record<string, unknown> {
  return {
    stage: observation.stage,
    reason: observation.reason,
    hostCode: normalizeHostCode(observation.hostCode),
    check: observation.check,
    exitCode: typeof observation.exitCode === 'number' && Number.isInteger(observation.exitCode) ? observation.exitCode : null,
    observedVersion: typeof observation.observedVersion === 'string' && observation.observedVersion ? observation.observedVersion : null,
    pendingRestart: observation.pendingRestart === true,
    intentHash: /^[0-9a-f]{8}$/.test(observation.intentHash) ? observation.intentHash : '00000000',
  }
}
