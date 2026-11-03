/**
 * selftest/fixtures/identity/scenario-declarations-hub-lifecycle.ts —— C 组：中枢生命周期与 profile 隔离声明（#284）
 *
 * owner：t5-implementer（票 #284，规格 #263 收口补充）。写入边界：只改本文件、本组场景文件与 runner；
 * 不改其他组的声明模块，不改 coverage-matrix / runs/README / known-red 等共享账本（由 Lead 串行落账），
 * 不改 src/ 产品代码（只有真 BUG 才允许修，且必须在报告里单独列出）。
 *
 * 场景 id（必须与 coverage-matrix 行 id、evidence run.json 的 scenarioId 一致）：
 *   M1 m1-hub-orphan-only-owner-a-returns  同进程全卸载后只回来 A：中枢自动接管孤儿子任务
 *   M2 m2-hub-orphan-only-owner-b-returns  只回来 B：B 不得冒领 A 的孤儿方案（第三幕 A 回来接手）
 *   M3 m3-owner-a-row-fails-still-alive    A 自己的批量行失败但 A 仍活着：B/C 继续、失败不拖累
 *   M4 m4-cross-profile-concurrency        不同 profile 并发更新：队列/锁隔离、互不阻塞
 *
 * 四条声明共用「A/B 两个批量集成方 + C 纯目标」拓扑；差异只在故障注入与恢复动作（由 runner 的 mode 决定）。
 * 主体代码见 selftest/real-machine/scenarios/hub-lifecycle.ts，runner 见 tools/run-hub-lifecycle.ts。
 */
import type { FixtureVariantDeclaration, ScenarioDeclaration, ScenarioInstallStep } from './scenario-declarations.ts'
import { batchEffectOf, targetEffectOf } from './scenario-declarations.ts'
import { FIXTURE_SLOT_A, FIXTURE_SLOT_B } from './fixture-slots.ts'

/** M1/M2 基版：只装两个批量集成方 A/B@0.0.1；C 不在册，作为 A 方案里的「孤儿目标」被中枢补装。 */
const HUB_BASE_INTEGRATORS: readonly ScenarioInstallStep[] = [
  { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
  { slotKey: 'b', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_B, false) },
]

/** M3 基版：A/B/C 三包都在册（A 发起三包批量，A 自己的行被改坏 tarball 打失败）。 */
const HUB_BASE_THREE: readonly ScenarioInstallStep[] = [
  { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
  { slotKey: 'b', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_B, false) },
  { slotKey: 'c', version: '0.0.1', effect: targetEffectOf('0.0.1') },
]

/** 三条目标都发 0.0.2：A/B 走批量变体（新版 UI + 中枢坞 + host behavior），C 走纯目标效果。 */
const HUB_VARIANTS: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_A, true) },
  { slotKey: 'b', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_B, true) },
  { slotKey: 'c', version: '0.0.2', changeClasses: ['behavior', 'metadata'], effect: targetEffectOf('0.0.2') },
]

/** M1：A/B 都发起批量，杀宿主后只回来 A —— A 采纳 fxa 方案推完，fxb 方案原样不动。 */
export const SCENARIO_M1_HUB_ORPHAN_ONLY_OWNER_A: ScenarioDeclaration = {
  id: 'm1-hub-orphan-only-owner-a-returns',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '中枢孤儿接管正向：同 profile 装 A/B 两个批量集成方@0.0.1，同时发起 A(fxa, targets a/b/c) 与 B(fxb, targets b/c) 批量；' +
    '在双方案在盘、A 自键已换、B/C 未终态时 SIGKILL 宿主（全部 fiber 消失）；从 profile 在册摘掉 B 后起第二代宿主（只回来 A）——' +
    'A 按 hub/plans/fxa.json 自动接管孤儿子任务并推完（C 被补装到 0.0.2），B 的 fxb 方案不被 A 改写/执行，无重复安装。',
  install: HUB_BASE_INTEGRATORS,
  variants: HUB_VARIANTS,
  expected: [
    '宿主 1 死前盘上确有两份方案 fxa.json/fxb.json 与活跃批量会话（raw 留 plan/batch/lease 原文 + 时间戳）',
    '第二代宿主（只回来 A）自动采纳 fxa 方案：无需人工续跑，B/C 行到终态、磁盘与台账完成 0.0.2/补装 C',
    'B 的 fxb 方案不被 A 冒领：fxb.json 字节/哈希不变、无 fxb 行执行、B 的目标 b/c 不被 A 的作业重复安装',
    'A 自己（fxa-a）恰一次成功安装；换手后每目标至多一次成功 exec（exactly-once，无重复/丢行）',
    '中枢租约换手单一属主（死进程 → 第二代 takeover，generation 记录实际值）；最终 UI 电话/台账/磁盘一致',
  ],
}

/** M2：同前置但只回来 B —— B 不冒领 fxa，先推完自己的 fxb；第三幕只装回 A，A 再采纳 fxa 收尾。 */
export const SCENARIO_M2_HUB_ORPHAN_ONLY_OWNER_B: ScenarioDeclaration = {
  id: 'm2-hub-orphan-only-owner-b-returns',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '中枢孤儿接管隔离：A/B 同时发起批量后杀宿主，只回来 B —— B 按属主过滤不得采纳 A 的 fxa 方案（fxb.json 以外不读、不改、不执行），' +
    'B 自己的 fxb 批次照常推完；第三幕只装回 A，A 再采纳 fxa 并推完（跨宿主方案保留有效、exactly-once、无重复安装）。',
  install: HUB_BASE_INTEGRATORS,
  variants: HUB_VARIANTS,
  expected: [
    '只回来 B 后：fxa 方案文件原样保留（字节/哈希不变）、无 fxa 行执行、A 的目标 a 不被 B 安装',
    'B 自己的 fxb 批次照常完成（b/c 到 0.0.2），台账 fxb-b/fxb-c 各恰一条成功终态',
    '第三幕只装回 A：A 采纳 fxa 并推完（跨宿主方案仍有效，C 补装完成），无重复安装',
    'xactly-once：各目标成功 exec ≤1（按属主/会话归属），台账无重复/丢行',
    '租约按宿主换手、单一属主；最终磁盘/台账/电话一致',
  ],
}

/** M3：A 自己行失败但 A 仍活着 —— 坏 A 的 tarball 字节（元数据不动），B/C 继续；恢复后重试只重跑 A。 */
export const SCENARIO_M3_OWNER_A_ROW_FAILS: ScenarioDeclaration = {
  id: 'm3-owner-a-row-fails-still-alive',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '失败隔离与活体中枢：A/B/C 全在册@0.0.1，发布 0.0.2 后把 A@0.0.2 tarball 字节改坏（元数据/integrity 不动 ⇒ check 能过、install 必失败）；' +
    '真 UI 从 A 面板发起「全部更新」——A 自键排第一并失败，A 仍活着、中枢继续泵完 B/C；恢复 tarball 后真 UI 重试，只有 A 行重跑并成功，B/C 不重复。',
  install: HUB_BASE_THREE,
  variants: HUB_VARIANTS,
  expected: [
    'A@0.0.2 tarball 字节被改坏但元数据/integrity 不动：改坏前后 HTTP 200、大小不变、版本元数据逐字节相同',
    '真 UI 宏「全部更新」后 A 行诚实失败（失败原因可归因到 integrity/安装失败），B/C 行继续并完成 0.0.2——无全批假成功',
    'A 仍活着：失败后 A 的 updateCheck/updateStatus 电话与中枢状态电话可答，中枢 pump 未死、租约未泄漏',
    '恢复 tarball 后真 UI 重试：只有 A 行重跑并成功（A 成功终态恰一条），B/C 不重复安装（exec 计数不变）',
    '最终 A/B/C 磁盘 0.0.2、台账三包各恰一条成功终态（A 含失败历史 + 成功终态），UI/台账/磁盘一致',
  ],
}

/** M4：同一 home 两个非 desktop profile 并发更新 —— 队列/锁按 profile 隔离，两个安装窗真实重叠。 */
export const SCENARIO_M4_CROSS_PROFILE: ScenarioDeclaration = {
  id: 'm4-cross-profile-concurrency',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    'profile 隔离：同一 home 下两个普通 profile（t14p1/t14p2）各装 A/B@0.0.1，两个 web 宿主同时开、分别绑一个 profile，' +
    '同时发起 A 的三包批量更新（targets a/b/c）——update-queue/<profile-hash>/ 各自独立、global.lock 不互斥，两个安装窗真实重叠/互不阻塞，' +
    '都完成 0.0.2、各自台账完整、无跨 profile 写入、无虚假 busy。',
  install: [
    { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
    { slotKey: 'b', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_B, false) },
  ],
  variants: HUB_VARIANTS,
  expected: [
    '两个宿主解析到不同 profileDir 与不同 update-queue/<shortHash> 目录（raw 留两套路径与锁文件）',
    '并发批量各自推进：两个安装窗时间真实重叠（exec 时间窗有交集）且互不阻塞（无 queue-busy/global.lock 跨 profile 冲突）',
    '两个 profile 最终都把 A（及批量目标）推到 0.0.2，磁盘/台账各自完整',
    '台账无跨 profile 写入：每个 profile 的 updates 目录只含本 profile 插件，另一个 profile 的目录不被触碰',
    '两个中枢租约各自独立（各自 hub/lease.json，属主 pid 不同），无虚假 busy/无抢占',
  ],
}

/** 四条 C 组声明（主声明文件 spread 进 SCENARIOS；顺序与矩阵行一致）。 */
export const HUB_LIFECYCLE_SCENARIOS: readonly ScenarioDeclaration[] = [
  SCENARIO_M1_HUB_ORPHAN_ONLY_OWNER_A,
  SCENARIO_M2_HUB_ORPHAN_ONLY_OWNER_B,
  SCENARIO_M3_OWNER_A_ROW_FAILS,
  SCENARIO_M4_CROSS_PROFILE,
]
