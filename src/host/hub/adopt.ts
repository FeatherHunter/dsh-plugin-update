// src/host/hub/adopt.ts —— 孤儿接管的后台边界（#249 的接管入口；#253 的异常边界）。
//
// 第一性：装载时扫盘上的方案、把「同一会话、未收尾」的批次交给中枢接着推，是纯旁路——
// 有它更好（自更新/重启后自动续跑），没它照旧（用户重开面板点继续）。所以这段异步代码
// 跑在 apply() 之外也必须满足宿主契约：**任何异常都不许变成未处理 rejection**（DSH 会致命退出）。
//
// 纪律：
//   - 单个方案的接管失败只放弃那一个方案，不影响下一个；
//   - 读方案（落盘端口）的异常按「没有方案」降级；
//   - 整个后台任务再兜一层——旁路代码绝不做进程退出的入口。

import type { HubPlan } from '../../core/hub/plan.js'
import { hubIoOf, safeReadPlans } from './boundary.js'
import { hubPathsForUpdate } from './plan-store.js'
import type { HubRuntimeDeps, HubScope } from './protocol.js'

/**
 * 一个方案的接管动作：属主过滤、忙碌判定、会话校验、席位装配都在调用方
 * （它是业务，不属于「后台边界」）；这里只保证「抛了不炸进程、不挡下一个」。
 */
export type HubOrphanAdopter = (plan: HubPlan) => Promise<void> | void

/**
 * 装载时异步扫一遍本使用范围的方案并交给中枢（不阻塞装载、不返回 Promise：纯旁路）。
 * 任何异常都停在这条边界里。
 */
export function adoptOrphanHubTasks(scope: HubScope, deps: HubRuntimeDeps, adopt: HubOrphanAdopter): void {
  void (async () => {
    try {
      const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
      if (!paths) return
      const plans = await safeReadPlans(hubIoOf(deps), paths)
      for (const plan of plans) {
        try {
          await adopt(plan)
        } catch {
          // 单个方案接管失败（坏账本、别家情况、宿主能力暂时不可用）：跳过，继续下一个。
        }
      }
    } catch {
      // 旁路兜底：孤儿接管是加速器，不是前置条件——这次扫盘失败就等下一次装载。
    }
  })()
}
