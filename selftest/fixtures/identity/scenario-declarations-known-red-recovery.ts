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
 * 本组允许扩展 selftest/fixtures/templates/integrator/integrator-host-half-template.ts 的 readerOverrides 注入（README.md:527/:564/:600 记录的集成方入口），并在 run.json 与笔记里写清等效宿主与真实性边界。
 */
import type { ScenarioDeclaration } from './scenario-declarations.ts'
import type { FixtureVariantEffect, FixtureVersion } from './fixture-slots.ts'

/**
 * 单面板效果（与 T1 legacySingleEffectOf 同值；本文件不 import 主声明模块，避免
 * scenario-declarations.ts → 本文件 → scenario-declarations.ts 的 ESM 循环依赖）。
 * 变体只改 UI 文案 + 构建标记：重启后 buildTag 从 host v0.0.1 变 host v0.0.2，是「代码真的换了版」的凭据。
 */
function singleEffectOf(version: FixtureVersion): FixtureVariantEffect {
  return {
    ui: 'single',
    titleSuffix: version === '0.0.2' ? '（新版）' : '',
    hubDock: false,
    hostBehavior: null,
    seatLine: '',
    // 单面板下再挂一颗「安装」按钮（#274 真机流程：panel check → ib check → install；F2 点它发起安装）
    installButton: true,
  }
}

/** 四格共用 A 席位：干净 profile 先装 A@0.0.1，更新目标 A@0.0.2（单面板效果）。 */
const RECOVERY_INSTALL = [{ slotKey: 'a' as const, version: '0.0.1' as const, effect: singleEffectOf('0.0.1') }]
const RECOVERY_VARIANTS = [
  { slotKey: 'a' as const, version: '0.0.2' as const, changeClasses: ['ui', 'metadata'] as const, effect: singleEffectOf('0.0.2') },
]

/** F2：等效第三方 Desktop（desktopProfiles 服务）上的出口一成功更新。 */
export const SCENARIO_F2_EXIT_ONE_THIRD_PARTY_SUCCESS: ScenarioDeclaration = {
  id: 'f2-exit-one-third-party-success',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '等效第三方 Desktop：宿主注册 desktopProfiles 服务（等效宿主），产品路由到出口一 desktop-service，' +
    'desktopPnpm.runPlugin 真 spawn 载体 CLI 把 A@0.0.1 更新到 A@0.0.2；磁盘三处与重启后 buildTag 都变',
  install: RECOVERY_INSTALL,
  variants: RECOVERY_VARIANTS,
  expected: [
    'update.install.exec route=desktop-service ok=true exitCode=0（不是 cli-process / desktop-manager）',
    '磁盘 dependencies/bundles/包内版本 = 0.0.2，重启后 buildTag = host v0.0.2',
    'runPlugin 收到的参数原文与真 CLI 退出码进 raw；不伪造安装结果',
    '等效宿主边界（desktopProfiles/desktopPnpm 由夹具注入、environmentKind 显式覆盖）写进 run.json',
  ],
}

/** F3：等效第三方 Desktop 上的出口一失败 + 无 terminate 能力超时诚实文案。 */
export const SCENARIO_F3_EXIT_ONE_THIRD_PARTY_FAILURE: ScenarioDeclaration = {
  id: 'f3-exit-one-third-party-failure',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '等效第三方 Desktop：出口一失败格。① registry 里 0.0.2 tarball 被删 → 载体 CLI 非零退出，产品记 install-failed/reason=nonzero-exit，' +
    'detail 是 CLI 原话，不假装成功；② runPlugin 无 terminate 能力且安装被挂起 → 超时原话逐字「宿主未提供终止能力」',
  install: RECOVERY_INSTALL,
  variants: RECOVERY_VARIANTS,
  expected: [
    'update.install.exec route=desktop-service ok=false；update.install.fail reason=nonzero-exit，detail 含 pnpm/CLI 原话',
    '超时格：reason=timeout，超时原话逐字「安装超时；宿主未提供终止能力，这次安装可能仍在后台继续」',
    '失败后人话格不得出现「已更新」「已是最新」；磁盘保持 0.0.1',
    '无 terminate 能力的 runPlugin 回包与挂起时长进 raw',
  ],
}

/** G8：等效 desktop-manager 无 cancelInstall 的超时诚实文案。 */
export const SCENARIO_G8_DESKTOP_MANAGER_NO_CANCEL_TIMEOUT: ScenarioDeclaration = {
  id: 'g8-desktop-manager-no-cancel-timeout',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '等效 desktop-manager：pluginManager 故意不提供 cancelInstall；installBundle 延迟超过 installTimeoutMs 后仍真 spawn CLI 装上 0.0.2。' +
    '产品超时必须说「宿主未提供取消能力」，不许说「已请求宿主取消」，且「可能仍在后台继续」为真',
  install: RECOVERY_INSTALL,
  variants: RECOVERY_VARIANTS,
  expected: [
    'update.install.exec route=desktop-manager ok=false；update.install.fail stage=exec reason=timeout code=install-failed',
    'detail 逐字含「安装超时；宿主未提供取消能力，这次安装可能仍在后台继续」，不含「已请求宿主取消」',
    '超时后 CLI 仍把 0.0.2 装进 profile（证明「可能仍在后台继续」不是免责话术）',
    '宿主仍可用（后续 updateStatus 电话有回包）',
  ],
}

/** I4：runningVersion 覆盖造出的真实 pending-restart 面板分支 + 摘在册重启不加载。 */
export const SCENARIO_I4_PENDING_RESTART_PANEL_TRUTH: ScenarioDeclaration = {
  id: 'i4-pending-restart-panel-truth',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '等效集成方注入 ReaderOverrides.runningVersion（README.md:564/:600）：真更新把磁盘推到 0.0.2 而运行版仍是 0.0.1，' +
    '面板「待重启」分支为真且不假称已生效；随后摘在册（不重启）面板改说未登记，重启后真不加载，恢复登记重启后真加载 0.0.2',
  install: RECOVERY_INSTALL,
  variants: RECOVERY_VARIANTS,
  expected: [
    '面板 seal/banner 显示「待重启」，runningVersion=0.0.1 与磁盘 0.0.2 不一致是真实观测，不谎称已生效',
    '摘在册后（不重启）面板改说「未登记」，文案与字典原文一致',
    '重启后夹具插件真不加载（页面无卡片/桥 404），证明「重启也不会加载」不是文案',
    '恢复登记并重启后 buildTag=host v0.0.2、runningVersion=0.0.2',
  ],
}

/** A 组四条声明（被 scenario-declarations.ts 的 SCENARIOS 数组 spread）。 */
export const KNOWN_RED_RECOVERY_SCENARIOS: readonly ScenarioDeclaration[] = [
  SCENARIO_F2_EXIT_ONE_THIRD_PARTY_SUCCESS,
  SCENARIO_F3_EXIT_ONE_THIRD_PARTY_FAILURE,
  SCENARIO_G8_DESKTOP_MANAGER_NO_CANCEL_TIMEOUT,
  SCENARIO_I4_PENDING_RESTART_PANEL_TRUTH,
]
