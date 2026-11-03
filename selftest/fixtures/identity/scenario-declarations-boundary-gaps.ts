/**
 * selftest/fixtures/identity/scenario-declarations-boundary-gaps.ts —— B 组：用户可感知边界缺口声明（#284）
 *
 * owner：t4-implementer（票 #284，规格 #263 收口补充）。写入边界：只改本文件、本组场景文件与 runner；
 * 不改其他组的声明模块，不改 coverage-matrix / runs/README / known-red 等共享账本（由 Lead 串行落账），
 * 不改 src/ 产品代码（只有真 BUG 才允许修，且必须在报告里单独列出）。
 *
 * 场景 id（必须与 coverage-matrix 行 id、evidence run.json 的 scenarioId 一致）：
 *   L1 同进程两插件同时点更新（A/B 各自电话并发）
 *   L2 registry 整体不可达时的失败诚实性
 *   L3 权限不足（安装目录不可写）
 *   L4 安装中关掉页面再打开
 *   L5 安装中硬杀宿主后的恢复行为
 *
本组只新增文件；需要破坏态时用外部手段（杀 verdaccio、ACL、杀进程），不要改产品代码或共享夹具模板。
 */
import type { ScenarioDeclaration } from './scenario-declarations.ts'

export const BOUNDARY_GAP_SCENARIOS: readonly ScenarioDeclaration[] = []
