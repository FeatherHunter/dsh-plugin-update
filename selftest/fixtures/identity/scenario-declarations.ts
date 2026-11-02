/**
 * selftest/fixtures/identity/scenario-declarations.ts —— 版本化场景声明（#266 T2 单一真源）。
 *
 * 一条场景声明回答四件事：干净 profile 装什么（基版）、更新时发布什么（变体版）、
 * 变体改的是哪类东西（UI / 行为 / 元数据）、以及预期是什么。
 *
 * 谁读它：
 *   - 发布器（selftest/real-machine/runtime/scenario-runner.ts）按声明发夹具版本；
 *   - 场景 runner（scenarios/*.ts）按声明写断言与预期（不许在自己的文件里再写死版本号/效果）；
 *   - 夹具单测（generator/fixture-package-plan.test.ts）核对「声明里的每个版本都能生成、矩阵里有对应行」。
 *
 * 扩展方式（评审要的「可复用」）：加一个版本变体 = 在对应场景的 variants 里加一条
 * {slotKey, version, changeClasses, effect}；加一个场景 = 加一条 ScenarioDeclaration + coverage-matrix 一行。
 */
import type { FixtureChangeClass, FixtureSlot, FixtureSlotKey, FixtureVariantEffect, FixtureVersion } from './fixture-slots.ts'
import { FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_SLOT_C, fixtureSlotOf } from './fixture-slots.ts'

/** 干净 profile 预装的一步：装哪个席位、装哪个版本、用什么效果渲染。 */
export interface ScenarioInstallStep {
  readonly slotKey: FixtureSlotKey
  readonly version: FixtureVersion
  readonly effect: FixtureVariantEffect
}

/** 一个要发布并被装上的版本变体。 */
export interface FixtureVariantDeclaration {
  readonly slotKey: FixtureSlotKey
  readonly version: FixtureVersion
  /** 这个变体相对基版改了什么（UI / 行为 / 元数据）；证据与矩阵按它说明。 */
  readonly changeClasses: readonly FixtureChangeClass[]
  readonly effect: FixtureVariantEffect
}

/** 一条场景声明（id 必须等于 coverage-matrix 的行 id、也等于 evidence run 的 scenarioId）。 */
export interface ScenarioDeclaration {
  /** 矩阵行 id（evidence run.json 的 scenarioId 用它）。 */
  readonly id: string
  /** 证据 run 的 ticket 前缀（run 目录名 = ticket-stamp）。 */
  readonly ticket: string
  readonly hostChannel: 'desktop-official' | 'dsh-web'
  readonly summary: string
  readonly install: readonly ScenarioInstallStep[]
  readonly variants: readonly FixtureVariantDeclaration[]
  /** 场景的预期（矩阵「预期」列的机器可读版本；场景 runner 的断言必须覆盖它们）。 */
  readonly expected: readonly string[]
}

/** T1 的单面板效果（场景 A；兼容 T1 场景复跑）。 */
export function legacySingleEffectOf(version: FixtureVersion): FixtureVariantEffect {
  return {
    ui: 'single',
    titleSuffix: version === '0.0.2' ? '（新版）' : '',
    hubDock: false,
    hostBehavior: null,
    seatLine: '',
  }
}

/**
 * 批量集成方的效果（T2 b/c 场景）。
 * 基版：批量面板 + 批量入口（能发起批量），无中枢坞、host 桥无 behavior 字段。
 * 变体：多挂中枢进度坞（新 UI 元素 + 轮询 updateHubStatus 的行为）+ host 桥新增 behavior 字段
 *       （client 把真 host 回复渲染成 [data-fixture-behavior]，所以「行为变了」不是编译期文案）。
 */
export function batchEffectOf(slot: FixtureSlot, variant: boolean): FixtureVariantEffect {
  const seatLine =
    slot.batch === null
      ? ''
      : '批量席位 ' + slot.batch.prefix + ' · 自键 ' + slot.batch.selfKey + ' · 目标 ' + slot.batch.targets.map((target) => target.key).join('/')
  return {
    ui: 'batch',
    titleSuffix: variant ? '（批量新版）' : '',
    hubDock: variant,
    hostBehavior: variant ? 'seat-aware-v2' : null,
    seatLine,
  }
}

/** 纯目标的效果（模板里目标不挂任何更新 UI；effect 只影响构建标记/清单，不影响接线）。 */
export function targetEffectOf(version: FixtureVersion): FixtureVariantEffect {
  return {
    ui: 'batch',
    titleSuffix: version === '0.0.2' ? '（新版）' : '',
    hubDock: false,
    hostBehavior: null,
    seatLine: '',
  }
}

/** 场景 A（#265 T1，单包主链）：保留在声明里，矩阵/LEDGER 可一并对账；runner 仍是 T1 那份。 */
export const SCENARIO_A_SINGLE_PACKAGE: ScenarioDeclaration = {
  id: 'a-single-package-main-chain',
  ticket: '265',
  hostChannel: 'desktop-official',
  summary: '单包主链：A@0.0.1 → 真 UI 检查/安装 → A@0.0.2 重启后可见变化',
  install: [{ slotKey: 'a', version: '0.0.1', effect: legacySingleEffectOf('0.0.1') }],
  variants: [
    {
      slotKey: 'a',
      version: '0.0.2',
      changeClasses: ['ui', 'metadata'],
      effect: legacySingleEffectOf('0.0.2'),
    },
  ],
  expected: ['运行版/已安装 0.0.2', '卡片标题与 client/host 构建标记变成新版', '磁盘、日志、台账三处一致'],
}

/** 场景 b（#266 T2）：两个批量集成方 + 一个纯目标同 profile，真 UI 批量更新。 */
export const SCENARIO_B_BATCH_TWO_INTEGRATORS: ScenarioDeclaration = {
  id: 'b-batch-two-integrators',
  ticket: '266',
  hostChannel: 'desktop-official',
  summary: 'A/B 两个批量集成方 + C 纯目标同装：A 发起批量更新，两席视图正确、三目标推到 0.0.2、无跨 scope 污染',
  install: [
    { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
    { slotKey: 'b', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_B, false) },
    { slotKey: 'c', version: '0.0.1', effect: targetEffectOf('0.0.1') },
  ],
  variants: [
    { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_A, true) },
    { slotKey: 'b', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_B, true) },
    { slotKey: 'c', version: '0.0.2', changeClasses: ['behavior', 'metadata'], effect: targetEffectOf('0.0.2') },
  ],
  expected: [
    'A 批量入口列出三个目标（a/b/c），B 批量入口列出两个目标（b/c）',
    'A 发起的批量更新把 a/b/c 的磁盘版本都推到 0.0.2',
    '两席各自面板行状态正确（A 三行、B 两行；互不串台）',
    '重启后 A/B 的 0.0.2 变体新 UI 元素与 host 行为字段出现，C 徽标 0.0.2',
    '批量账本/队列/中枢计划/日志按属主隔离，无跨 scope 污染',
  ],
}

/** 场景 c（#266 T2）：纯目标 C 被 A 批量推到 0.0.2，且 C 自己没有任何更新 UI/接线。 */
export const SCENARIO_C_PURE_TARGET: ScenarioDeclaration = {
  id: 'c-pure-target-no-wiring',
  ticket: '266',
  hostChannel: 'desktop-official',
  summary: 'A@0.0.1 + C（纯目标）@0.0.1：A 批量把 C 推到 0.0.2，C 页面没有 .dsh-upd 面板/入口',
  install: [
    { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
    { slotKey: 'c', version: '0.0.1', effect: targetEffectOf('0.0.1') },
  ],
  variants: [{ slotKey: 'c', version: '0.0.2', changeClasses: ['behavior', 'metadata'], effect: targetEffectOf('0.0.2') }],
  expected: [
    'C 被 A 的批量动作推到 0.0.2（磁盘 + C 徽标 + A 面板行）',
    'C 的卡片/页面没有 .dsh-upd 面板、没有更新入口',
    'C 的包清单不依赖 dsh-plugin-update（无更新接线的最强证据）',
    'A 自己保持 0.0.1（只推纯目标，不把「顺序里没更新的行」也动掉）',
  ],
}

/**
 * T3（#267）三出口矩阵的六条声明。
 *
 * 命名：d*=出口二（官方桌面 in-process 插件管理器，通道 A），e*=出口三（普通 DSH 宿主 spawn CLI，
 * 通道 B），f*=出口一（第三方 Desktop，本机不可达，只做能力探测）。每条声明 = 矩阵一行；
 * 出口二/三的成功与失败格共用同一套基版/变体（A@0.0.1 → A@0.0.2，单面板效果），
 * 差别只在故障注入与断言组，这样两格之间的「变化」只有故障，不掺别的变量。
 */
const THREE_EXIT_INSTALL: readonly ScenarioInstallStep[] = [{ slotKey: 'a', version: '0.0.1', effect: legacySingleEffectOf('0.0.1') }]
const THREE_EXIT_VARIANTS: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'metadata'], effect: legacySingleEffectOf('0.0.2') },
]

/** 出口二成功格：官方桌面插件管理器 remove→install 两步真机更新。 */
export const SCENARIO_D1_DESKTOP_MANAGER_SUCCESS: ScenarioDeclaration = {
  id: 'd1-desktop-manager-update-success',
  ticket: '267',
  hostChannel: 'desktop-official',
  summary: '出口二成功：官方桌面 in-process 插件管理器把 A@0.0.1 更新到 A@0.0.2（remove→install 两步）',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    'check 后目标版本 0.0.2 可安装（面板/电话一致）',
    '.plugin-manager/logs 时间窗内恰两次非空 operation：先移除 A@0.0.1、后安装 A@0.0.2',
    'update.install.exec route=desktop-manager ok=true，且无 update.install.fail',
    '磁盘 dependencies/包内版本与重启后 UI 都是 0.0.2',
  ],
}

/** 出口二失败格：check 后下架 0.0.2，安装以 install-failed 收局（诚实面）。 */
export const SCENARIO_D2_DESKTOP_MANAGER_FAILURE: ScenarioDeclaration = {
  id: 'd2-desktop-manager-update-failure',
  ticket: '267',
  hostChannel: 'desktop-official',
  summary: '出口二失败：check 正常；安装时 registry 里 0.0.2 的 tarball 被删（元数据/integrity 不动），管理器移除步成功、重装失败；产品稳定码 install-failed + 宿主原话 + 可执行手工命令',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    '安装电话先 ok:true 受理（异步）；失败落在后续快照任务 job.state=failed，message 以 install-failed 开头',
    'update.install.fail stage=exec reason=nonzero-exit，update.install.exec route=desktop-manager ok=false',
    'HMR 宿主的失败必然发生在第二步：人话格「目标包已被宿主移除，重装失败」+ 可执行载体命令',
    '磁盘保持 0.0.1（失败不假装成功）；首装 registry 类失败的「无载体命令」诚实面在 HMR 宿主不可达（库内覆盖）',
  ],
}

/** 出口三成功格：普通 DSH 宿主 spawn CLI 子进程把 A@0.0.1 更新到 A@0.0.2。 */
export const SCENARIO_E1_CLI_HOST_SUCCESS: ScenarioDeclaration = {
  id: 'e1-cli-host-update-success',
  ticket: '267',
  hostChannel: 'dsh-web',
  summary: '出口三成功：普通 DSH 宿主（非 desktop profile）spawn CLI 子进程更新 A@0.0.1→A@0.0.2',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    'update.install.exec route=cli-process ok=true exitCode=0',
    '磁盘 0.0.2、重启后 buildTag=host v0.0.2',
    '电话回包 ok=true 与日志/磁盘一致（电话先回、exec 后完，完成判据用磁盘+日志）',
  ],
}

/** 出口三失败格：check 后下架 0.0.2，CLI 子进程非零退出，产品记 install-failed。 */
export const SCENARIO_E2_CLI_HOST_FAILURE: ScenarioDeclaration = {
  id: 'e2-cli-host-update-failure',
  ticket: '267',
  hostChannel: 'dsh-web',
  summary: '出口三失败：check 正常；安装时删 registry 里 0.0.2 的 tarball（元数据不动），载体 CLI 子进程 pnpm 404 非零退出；稳定码 install-failed + 原话，磁盘不变',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    'update.install.exec route=cli-process ok=false exitCode 非空',
    'update.install.fail stage=exec reason=nonzero-exit code=install-failed',
    '失败人话格给出 detail 原话；registry 类失败不出现载体命令',
    '磁盘保持 0.0.1',
  ],
}

/** 出口三超时格：installTimeoutMs=4s，载体 CLI 子进程被终止。 */
export const SCENARIO_E3_CLI_HOST_TIMEOUT: ScenarioDeclaration = {
  id: 'e3-cli-host-install-timeout',
  ticket: '267',
  hostChannel: 'dsh-web',
  summary: '出口三超时：installTimeoutMs=4s，安装请求被挂起，产品超时终止 CLI 子进程并给超时原话',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    'update.install.exec route=cli-process ok=false，durationMs 落在 [4000, 4000+3000) 宽限内',
    'update.install.fail reason=timeout code=install-failed',
    '失败任务 message 的超时原话「安装超时，已终止子进程」（宿主未提供终止能力时为 no-terminate 变体）',
    '磁盘保持 0.0.1',
  ],
}

/** 出口一探测格：本机能力探测 + 官方桌面 hostKind 负向证据；真机更新记 known-red。 */
export const SCENARIO_F1_THIRD_PARTY_DESKTOP_PROBE: ScenarioDeclaration = {
  id: 'f1-third-party-desktop-probe',
  ticket: '267',
  hostChannel: 'desktop-official',
  summary: '出口一探测：本机只有官方桌面（无第三方 Desktop / desktopProfiles 服务），留原始探测证据并判 known-red',
  // 探测格也要装一份基版夹具：面板/日志只有插件在宿主里跑起来才有，hostKind 负向证据要靠它。
  install: THREE_EXIT_INSTALL,
  variants: [],
  expected: [
    '文件系统/卸载表/服务探测原始输出进 raw 证据',
    '官方桌面 hostKind=desktop-manager（desktopProfiles 为空）为出口一不可达的负向证据',
    '出口一真机更新（成功格与失败格）断言记 known-red，不伪造真机结果',
  ],
}

/** 全部场景声明（矩阵行 id 一一对应）。 */
export const SCENARIOS: readonly ScenarioDeclaration[] = [
  SCENARIO_A_SINGLE_PACKAGE,
  SCENARIO_B_BATCH_TWO_INTEGRATORS,
  SCENARIO_C_PURE_TARGET,
  SCENARIO_D1_DESKTOP_MANAGER_SUCCESS,
  SCENARIO_D2_DESKTOP_MANAGER_FAILURE,
  SCENARIO_E1_CLI_HOST_SUCCESS,
  SCENARIO_E2_CLI_HOST_FAILURE,
  SCENARIO_E3_CLI_HOST_TIMEOUT,
  SCENARIO_F1_THIRD_PARTY_DESKTOP_PROBE,
]

/** 按 id 取场景（未知 id 立刻抛，避免证据跑错场景却记为另一个）。 */
export function scenarioOf(id: string): ScenarioDeclaration {
  const found = SCENARIOS.find((scenario) => scenario.id === id)
  if (!found) throw new Error('[fixtures] 未知场景 id：' + JSON.stringify(id) + '（允许 ' + SCENARIOS.map((scenario) => scenario.id).join('/') + '）')
  return found
}

/** 场景的预装席位（去重、保持声明顺序；场景 runner 用它决定 CLI 装哪几个包）。 */
export function installSlotsOf(scenario: ScenarioDeclaration): FixtureSlot[] {
  const keys: FixtureSlotKey[] = []
  for (const step of scenario.install) if (keys.indexOf(step.slotKey) < 0) keys.push(step.slotKey)
  return keys.map((key) => fixtureSlotOf(key))
}
