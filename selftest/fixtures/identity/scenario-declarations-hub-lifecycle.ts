/**
 * selftest/fixtures/identity/scenario-declarations-hub-lifecycle.ts —— C 组：中枢生命周期与 profile 隔离声明（#284）
 *
 * owner：t5-implementer（票 #284，规格 #263 收口补充）。写入边界：只改本文件、本组场景文件与 runner；
 * 不改其他组的声明模块，不改 coverage-matrix / runs/README / known-red 等共享账本（由 Lead 串行落账），
 * 不改 src/ 产品代码（只有真 BUG 才允许修，且必须在报告里单独列出）。
 *
 * 场景 id（必须与 coverage-matrix 行 id、evidence run.json 的 scenarioId 一致）：
 *   M1 同进程全卸载后只回来 A：中枢自动接管孤儿子任务
 *   M2 只回来 B：B 不得冒领 A 的孤儿方案
 *   M3 A 自己的批量行失败但 A 仍活着：B/C 是否继续
 *   M4 不同 profile 并发更新互不串台
 *
本组复用既有 hub/batch 场景骨架；若需要宿主重启/换手，用官方桌面串行或 web 宿主重启，时间窗断言以租约（5s 心跳 / 20s 失联）为准。
 */
import type { ScenarioDeclaration } from './scenario-declarations.ts'

export const HUB_LIFECYCLE_SCENARIOS: readonly ScenarioDeclaration[] = []
