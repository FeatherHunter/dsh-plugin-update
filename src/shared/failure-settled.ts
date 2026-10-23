// src/shared/failure-settled.ts —— 失败任务的「已结算」判据（#245）。
//
// 为什么需要它：盘上的 job 是历史账本。安装失败/中断之后，后来的一次更新可能已经把目标版本
// 装好并跑起来；那条失败仍是历史事实，但不得再冒充「当前更新失败」——否则面板横幅、入口件、
// 日志面板状态、复制诊断会一起把用户按在一个早已不存在的失败面上（#245 的实机症状）。
//
// 一个判定、一处实现：所有消费方（panel/view-model、panel/entry、panel/mount、panel/render、
// core/install-button/mount）都问这一个纯函数，不各写一套版本比较，避免口径漂移。
// 了结之后「哪些失败锁存该清」也只写在这里（settledClearsLatch），面板与安装按钮件共用。
//
// 判据取严（任一未知/不满足即 false，绝不猜）：
//   - job 存在且 state 为 failed / interrupted（在途与成功终态不适用）；
//   - job.targetVersion 是合法发行版号 T；
//   - snapshot.installed === true（磁盘上真有这个包；#238）；
//   - snapshot.registered === true（宿主确实在册；#190：未登记就不算「已生效」）；
//   - 磁盘安装版本与运行版本是同一版（compareReleaseVersions === 0）；
//   - 两者都 >= T —— 更新只往前走，比 T 更高的版本在跑，同样说明目标已生效。
//
// 纯函数、无 I/O、永不抛：快照形状不认或版本比较失败一律 false。

import { compareReleaseVersions, validReleaseVersion } from '../core/service.js'
import { isCheckSideFailureCode } from './codes.js'
import type { UpdateSnapshot } from './ports.js'
import { normalizeRunningVersion } from './version.js'

/** 这条快照里的失败/中断任务，是否已被「目标版本确实在跑」的版本证据结算。 */
export function failureSettledOf(snapshot: UpdateSnapshot | null | undefined): boolean {
  try {
    if (!snapshot || typeof snapshot !== 'object') return false
    const job = snapshot.job
    if (!job || typeof job !== 'object') return false
    if (job.state !== 'failed' && job.state !== 'interrupted') return false
    const target = typeof job.targetVersion === 'string' ? job.targetVersion.trim() : ''
    if (!target || !validReleaseVersion(target)) return false
    if (snapshot.installed !== true) return false
    if (snapshot.registered !== true) return false
    const installed = typeof snapshot.installedVersion === 'string' ? snapshot.installedVersion.trim() : ''
    if (!installed || !validReleaseVersion(installed)) return false
    const running = normalizeRunningVersion(snapshot.runningVersion)
    if (!running || !validReleaseVersion(running)) return false
    if (compareReleaseVersions(installed, running) !== 0) return false
    return compareReleaseVersions(installed, target) >= 0
  } catch {
    return false
  }
}

/**
 * 已了结的失败任务，是否该清掉当前的失败锁存（#58 / #245）。
 *
 * 装侧锁存由失败 job 派生，job 一被版本证据了结它就不再是当下事实，就地解除且不再重建；
 * 查侧锁存（读/联网失败）是当下证据，仍循 #58 只由一次成功查询解除。面板与安装按钮件
 * 共用这一条规则，不各写一份判断。
 */
export function settledClearsLatch(latch: { source?: unknown; code?: unknown } | null | undefined): boolean {
  if (!latch || typeof latch !== 'object') return false
  return latch.source === 'install' || !isCheckSideFailureCode(latch.code)
}
