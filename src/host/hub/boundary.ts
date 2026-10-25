// src/host/hub/boundary.ts —— 中枢的异常边界：后台泵/退避/孤儿接管碰到任何异常都不许外抛。
//
// 宿主契约（dsh-app-boot README「启动与重载失败」表，2026-10-25 取证）：
//   **脱离 apply() 返回 Promise 的异步任务产生未处理 rejection ＝ 致命错误：释放应用并以非零码退出。**
// 中枢恰恰活在 apply() 之外：提交后的推进、退避重试、装载时的孤儿接管都跑在宿主事件循环的后台。
// 所以这里把「后台代码能碰到的每一种失败」收成显式结局：
//
//   1. 落盘层（本文件）：租约/方案的读/写/释放。ADR-0008 的 best-effort 口径——
//      读坏当没有、写坏当本次不交接、释放失败只多留一份过期租约；意外抛出的异常同样降级。
//      只有**租约读/写**额外标 fault：它们决定「我是不是驾驶位」，坏 I/O 靠等不自愈，
//      必须让调用方计数并在上限给明确 failed（否则会每秒空转）；释放与方案读写是一次性旁路，
//      降级后没有可等的后续，只吞掉不外抛。
//   2. 任务层（registry.ts 的 runTaskGuarded）：一个任务里的未预期异常 → 该任务明确 failed，
//      等待者拿到终态，泵继续下一个。
//   3. 旁路层（adopt.ts 的 adoptOrphanHubTasks / registry.ts 的退避定时器）：只让这一次放弃。
//
// 纪律：本文件不做判决、不读钟、不持有状态；所有降级都写在这里，别散回各调用点。
// 回滚线：删掉本文件不代表中枢停摆——它只是把「不会外抛」这件事集中到一处，便于审查。

import type { HubLease } from '../../core/hub/lease-policy.js'
import type { HubPlan } from '../../core/hub/plan.js'
import { readHubLease, releaseHubLease, writeHubLease } from './lease-store.js'
import { readHubPlans, writeHubPlan, type HubPaths } from './plan-store.js'
import type { HubIo, HubRuntimeDeps } from './protocol.js'

/** 真实落盘端口（生产唯一实现；测试可在它上面覆盖一两个方法注入故障）。 */
export const DEFAULT_HUB_IO: HubIo = {
  readLease: readHubLease,
  writeLease: writeHubLease,
  releaseLease: releaseHubLease,
  readPlans: readHubPlans,
  writePlan: writeHubPlan,
}

/** 取本次运行要用的端口：注入优先，缺省真实文件系统。 */
export function hubIoOf(deps: HubRuntimeDeps): HubIo {
  return deps.io ?? DEFAULT_HUB_IO
}

/** 一次端口调用的结果：value 是「当没有/没写进去」的回值，fault 表示这次真的抛了。 */
export interface HubIoOutcome<T> {
  value: T
  fault: boolean
}

/** 读租约：异常 → 当没有（但标 fault，让调用方别把坏 I/O 当正常等待无限重试）。 */
export async function safeReadLease(io: HubIo, paths: HubPaths): Promise<HubIoOutcome<HubLease | null>> {
  try {
    return { value: await io.readLease(paths), fault: false }
  } catch {
    return { value: null, fault: true }
  }
}

/**
 * 写租约。两类失败要分清：
 *   - 端口**返回 false**：正常的「这次没写进去」——按 ADR-0008 退回本进程单飞，不挡安装；
 *   - 端口**抛出异常**：未预期故障，标 fault；调用方按「拿不到驾驶位」让位重排队，
 *     连续到上限判 failed（#253：坏 I/O 不许被当成正常推进，也不许每秒空转）。
 */
export async function safeWriteLease(io: HubIo, paths: HubPaths, lease: HubLease): Promise<HubIoOutcome<boolean>> {
  try {
    return { value: await io.writeLease(paths, lease), fault: false }
  } catch {
    return { value: false, fault: true }
  }
}

/** 释放租约：异常 → 吞掉（只多留一份过期租约，下一个驾驶者按心跳/死进程接管）。 */
export async function safeReleaseLease(
  io: HubIo,
  paths: HubPaths,
  driverId: string,
  generation: number,
): Promise<void> {
  try {
    await io.releaseLease(paths, driverId, generation)
  } catch {
    // 释放是收尾旁路：失败不改变任何已给出的结局，也绝不外抛。
  }
}

/** 列方案：异常 → 当没有方案（孤儿接管退化成「这次不接」，安装照旧）。 */
export async function safeReadPlans(io: HubIo, paths: HubPaths): Promise<HubPlan[]> {
  try {
    return await io.readPlans(paths)
  } catch {
    return []
  }
}

/** 写方案：异常 → 当没写进去（不影响本进程推进，只影响别人接手）。 */
export async function safeWritePlan(io: HubIo, paths: HubPaths, plan: HubPlan | null | undefined): Promise<boolean> {
  try {
    return await io.writePlan(paths, plan)
  } catch {
    return false
  }
}
