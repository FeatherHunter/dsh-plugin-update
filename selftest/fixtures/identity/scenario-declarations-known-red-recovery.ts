/**
 * selftest/fixtures/identity/scenario-declarations-known-red-recovery.ts —— A 组：known-red 转真机声明（#284）
 *
 * owner：t3-implementer（票 #284，规格 #263 收口补充）。写入边界：只改本文件、本组场景文件与 runner；
 * 不改其他组的声明模块，不改 coverage-matrix / runs/README / known-red 等共享账本（由 Lead 串行落账），
 * 不改 src/ 产品代码（只有真 BUG 才允许修，且必须在报告里单独列出）。
 *
 * 场景 id（必须与 coverage-matrix 行 id、evidence run.json 的 scenarioId 一致）：
 *   F2 等效第三方 Desktop：出口一成功（desktopProfiles + desktopPnpm.runPlugin 真装）
 *   F3 等效第三方 Desktop：出口一失败 + 无终止能力诚实文案
 *   G8 等效 desktop-manager 无 cancelInstall：超时文案必须说「未提供取消能力」
 *   I4 readerOverrides.runningVersion 达成的真实 pending-restart 面板分支 + 摘在册重启不加载
 *
本组允许扩展 selftest/fixtures/templates/integrator/integrator-host-half-template.ts 的 readerOverrides 注入（README.md:527/:564/:600 记录的集成方入口），并在 run.json 与笔记里写清等效宿主与真实性边界。
 */
import type { ScenarioDeclaration } from './scenario-declarations.ts'

export const KNOWN_RED_RECOVERY_SCENARIOS: readonly ScenarioDeclaration[] = []
