// src/host/hub/protocol.ts —— 更新中枢的协议：谁在推、推什么、推完告诉谁。
//
// 第一性：批量推进不该绑定在某个插件 fiber 上。发起方（任一集成插件）只需要提交一份「执行席」——
// 把宿主能力（查/装/落盘/日志）与方案冻结成一个值；之后谁活着、谁拿着租约，谁就能接着推。
// 本文件只有类型与常量（零 IO、零状态），协议版本是宿主两个版本共存时的判据。

import type { BatchSession } from '../../core/batch/model.js'
import type { BatchCheckOutcome, BatchInstallOutcome, BatchRunDeps, BatchRunStep, BatchStoppedByBecause } from '../../core/batch/run.js'
import type { HubLease } from '../../core/hub/lease-policy.js'
import type { HubPlan } from '../../core/hub/plan.js'
import type { HubPaths } from './plan-store.js'

/**
 * 中枢协议版本：读不懂的租约/方案一律不接管（见 lease-store / plan-store 的归一）。
 *
 * 也决定注册表挂哪个 Symbol（#254）：换代时两代实现各用各的槽，旧任务表原样留给旧泵排空，
 * 绝不会像 0.18.39 那样因为版本字符串恰好相同而把新任务塞进旧任务表。
 */
export const HUB_PROTOCOL_VERSION = 2

/** 让位（排队/锁被占/租约不在手）之后多久再试一次；不与 drain 抢节拍。 */
export const HUB_RETRY_INTERVAL_MS = 1000

/**
 * 租约端口连续抛未预期异常多少次后把任务判 failed（#253）。
 * 让位等待是正常的（别家占着驾驶位，等到就是）；但坏 I/O 不是等待能解决的——
 * 不设上限就会每秒重试到进程结束（空转）。到上限给一个明确结局，把会话留给下一次续跑。
 */
export const HUB_MAX_LEASE_FAULTS = 3

/** 中枢实例看待自己所在使用范围的三个坐标（家目录、使用范围目录、使用范围名）。 */
export interface HubScope {
  homeDir: string
  profileDir: string
  profileName: string
}

/**
 * 一个批次的执行席：提交时由发起方冻结，之后中枢每步只调这些函数。
 * 纪律：席位里的函数必须只依赖盘与宿主能力，不依赖「发起方的 UI 还在不在」。
 */
export interface HubSeat {
  /** 属主 = 批量前缀（batch.json 的落盘目录名，ADR-0003）。 */
  owner: string
  /** 可被任一存活集成方接手重装的持久任务书（core/hub/plan.ts 的形状）。 */
  plan: HubPlan
  readSession(): Promise<BatchSession>
  saveSession(session: BatchSession): Promise<void>
  check(key: string): Promise<BatchCheckOutcome>
  install(key: string, requestId: string, version: string): Promise<BatchInstallOutcome>
  /** 日志落点（与驱动器同一口径；没接线即函数缺失）。 */
  logFor?: BatchRunDeps['logFor']
  /** 失败行的整批序号（视图可能只含选中的几行，不能用视图下标）。 */
  indexOf(key: string): number
  /** 开始/结束驱动：让本实例的其它电话看到「忙」，结束后必须复位。 */
  enterDrive?(): void
  exitDrive?(): void
  /**
   * 接手续跑前的补写（#254）：旧一代忙时席位是只读装的，泵真正拿到驾驶位后调一次——
   * 重读最新账本、把中断相位退回 pending、清上一任排队占位、记续跑日志。
   * 只允许做「本来该在装载时做、但旧一代还活着所以推迟」的写；抛异常按任务失败处理。
   */
  takeOver?(): void | Promise<void>
  /** 一次任务收尾（done/failed）后的旁路：让发起方补日志、更新 lastRun。永不改变判定。 */
  onSettled?(report: HubSettledReport): void | Promise<void>
}

/** 中枢提交结果的三种诚实结局。 */
export type HubTaskOutcome =
  /** 任务已在本次调用内推到收尾（或盘上已是收尾态）。 */
  | 'done'
  /** 本次调用没能推完（忙/排队/让位），中枢会在退避后自己继续。 */
  | 'queued'
  /** 驱动器抛错、无进展太久或协议不可用：给出真相。 */
  | 'failed'

/** 任务收尾报告（只对 done/failed 发；排队让位不发，避免把「还没完」写成收尾）。 */
export interface HubSettledReport {
  outcome: Exclude<HubTaskOutcome, 'queued'>
  stoppedBecause: BatchStoppedByBecause
  steps: readonly BatchRunStep[]
  /** 收尾时读到的会话（读盘失败为 null）。 */
  session: BatchSession | null
}

/** 定时器口子：测试给假件即能确定性地断言「起没起、停没停」。 */
export interface HubTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/**
 * 中枢落盘端口：租约与方案的读/写/释放。
 *
 * 真实实现在 lease-store / plan-store（它们自己已把「坏文件当没有」降级）；这个端口存在的意义是
 * 让边界（boundary.ts）能对**任何**未预期异常做最后一道兜底，并让测试在四个 seam 上注入异常（#253）。
 * 契约：实现可以返回 null / false 表示「没有 / 没写进去」，但**不许**把异常当正常回值；
 * 意外异常由边界收住并降级。其中租约读/写的异常会被标记 fault 并计数（HUB_MAX_LEASE_FAULTS），
 * 释放与方案读写只降级不外抛（一次性旁路，没有「等它自愈」的语义）。
 */
export interface HubIo {
  readLease(paths: HubPaths): Promise<HubLease | null>
  writeLease(paths: HubPaths, lease: HubLease): Promise<boolean>
  releaseLease(paths: HubPaths, driverId: string, generation: number): Promise<void>
  readPlans(paths: HubPaths): Promise<HubPlan[]>
  writePlan(paths: HubPaths, plan: HubPlan | null | undefined): Promise<boolean>
}

/** 中枢运行期事实（时钟、编号、定时器、进程号）：全部由调用方给，注册表不读钟。 */
export interface HubRuntimeDeps {
  now(): number
  randomId(): string
  timers: HubTimers
  pid: number
  /** 进程是否还活着（判断能不能接管别人的租约）；缺省走 process.kill 探测。 */
  isProcessAlive?(pid: number): boolean
  /** 让位后重试间隔（缺省 HUB_RETRY_INTERVAL_MS；测试可调小）。 */
  retryMs?: number
  /** 落盘端口（缺省真实文件系统；测试注入会抛异常的假端口验证异常边界）。生产不传。 */
  io?: HubIo
}
