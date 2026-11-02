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
  readonly hostChannel: 'desktop-official'
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

/** 全部场景声明（矩阵行 id 一一对应）。 */
export const SCENARIOS: readonly ScenarioDeclaration[] = [SCENARIO_A_SINGLE_PACKAGE, SCENARIO_B_BATCH_TWO_INTEGRATORS, SCENARIO_C_PURE_TARGET]

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
