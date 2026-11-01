/**
 * selftest/fixtures/identity/fixture-slots.ts —— 夹具身份单源（#265 T1 / #258 §6 已批准 S2）。
 *
 * 本文件只回答「谁是谁」：包名、pluginId、电话前缀、角色、版本序列、可见变化文案。
 * 模板渲染（templates/）、生成（generator/）、发布（release/）、真机场景都从这里读，禁止第二份字面量。
 *
 * 三个席位（#258 §6 人类已批准方案 S2：3 包 = A/B 两个批量集成方 + C 纯目标）：
 *   A：批量集成方，targets [a,b,c]，selfKey='a'，selfOrder='first'（先把本体换掉再续推）。
 *   B：批量集成方，targets [b,c]，selfKey='b'，selfOrder='last'（缺省：先升别家最后升自己）。
 *   C：纯目标，无更新接线，只被 A/B 当靶子。
 * #265（T1）只要求 A 上真机跑主链；B/C 本轮只要求「声明 + 能生成」。
 *
 * 约束来源（改这里之前先读）：
 * - 包名必须过 MANAGER_TARGET_RE（src/shared/commands.ts:37）——工具层不 import 产品源码，
 *   这里抄同一判据 FIXTURE_PACKAGE_NAME_RE，并在单测里钉住它的形状（全小写、无空格、可带 scope）。
 * - 目标 prefix 互不相同且不与所属批量前缀撞车（src/host-batch.ts:40-41 「七个必须互不相同，否则串台」）。
 * - 版本 0.0.x 与主包版本解耦（#262）。
 */

/** 夹具席位键（A/B/C 三个已批准角色）。 */
export type FixtureSlotKey = 'a' | 'b' | 'c'

/** 角色：集成方（自己也是被更新目标）或纯目标（只被更新）。 */
export type FixtureRole = 'integrator' | 'target'

/** 夹具版本序列（0.0.x，与主包解耦；#265 用 0.0.1 基版 / 0.0.2 变体版）。 */
export const FIXTURE_VERSION_SEQUENCE = ['0.0.1', '0.0.2'] as const
export type FixtureVersion = (typeof FIXTURE_VERSION_SEQUENCE)[number]

/** 主链场景的基版（安装进干净 profile 的旧版）。 */
export const FIXTURE_BASE_VERSION: FixtureVersion = '0.0.1'
/** 主链场景的变体版（发布后由真 UI 装上的新版）。 */
export const FIXTURE_VARIANT_VERSION: FixtureVersion = '0.0.2'

/** 「自己」在批量会话里的排位（与 src/core/batch/model.ts 的 BatchSelfOrder 同词）。 */
export type FixtureSelfOrder = 'first' | 'last'

/** 包名判据副本（src/shared/commands.ts:37 MANAGER_TARGET_RE 的同一形状；工具层不 import 产品源码）。 */
export const FIXTURE_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

/** 包名前缀：与产品自己的包名（dsh-plugin-update）明显区分，且过 MANAGER_TARGET_RE。 */
export const FIXTURE_PACKAGE_PREFIX = 'dsh-plugin-update-fixture-'

/** 夹具包在 npm 描述里的「只作测试」标记（发布到本地 registry 时也不冒充产品）。 */
export const FIXTURE_EVIDENCE_TAG = 'TEST ONLY sed: selftest fixture for dsh-plugin-update'

/** 一个批量目标：被更新的包 + 它在电话表里的单插件前缀。 */
export interface FixtureTargetBinding {
  /** 会话内稳定键（方案要求 targets key 唯一）。 */
  readonly key: string
  /** 面板行首中文名。 */
  readonly title: string
  /** 该目标的包名（= 被更新的那个包的 package.json name）。 */
  readonly packageName: string
  /** 该目标的单插件电话前缀（同一批量里七个必须互不相同）。 */
  readonly prefix: string
}

/** 集成方的批量接线（对应 createMultiHostUpdate 的 {prefix,selfKey,selfOrder,targets}）。 */
export interface FixtureBatchBinding {
  /** 批量电话前缀（七个批量电话 = <prefix>.batchStatus 等）。 */
  readonly prefix: string
  /** 「自己」的键：只作日志属主识别与排位。 */
  readonly selfKey: string
  /** 「自己」的排位。 */
  readonly selfOrder: FixtureSelfOrder
  /** 目标清单（顺序即会话顺序）。 */
  readonly targets: readonly FixtureTargetBinding[]
}

/** 一个夹具席位。 */
export interface FixtureSlot {
  readonly key: FixtureSlotKey
  readonly role: FixtureRole
  readonly packageName: string
  readonly pluginId: string
  /** 集成方才有批量接线；纯目标为 null。 */
  readonly batch: FixtureBatchBinding | null
  /** 集成方「自己」的目标电话前缀（client 面板绑这个）；纯目标为 null。 */
  readonly selfTargetPrefix: string | null
  readonly description: string
  readonly versions: readonly FixtureVersion[]
}

/** A：批量集成方（targets a,b,c；自家排第一）。#265 主链本体。 */
export const FIXTURE_SLOT_A: FixtureSlot = {
  key: 'a',
  role: 'integrator',
  packageName: FIXTURE_PACKAGE_PREFIX + 'a',
  pluginId: FIXTURE_PACKAGE_PREFIX + 'a',
  batch: {
    prefix: 'fxa',
    selfKey: 'a',
    selfOrder: 'first',
    targets: [
      { key: 'a', title: '夹具 A 本体', packageName: FIXTURE_PACKAGE_PREFIX + 'a', prefix: 'fxa-a' },
      { key: 'b', title: '夹具 B', packageName: FIXTURE_PACKAGE_PREFIX + 'b', prefix: 'fxa-b' },
      { key: 'c', title: '夹具 C', packageName: FIXTURE_PACKAGE_PREFIX + 'c', prefix: 'fxa-c' },
    ],
  },
  selfTargetPrefix: 'fxa-a',
  description: '批量集成方（本体 + 两家目标；本体 first）',
  versions: FIXTURE_VERSION_SEQUENCE,
}

/** B：批量集成方（targets b,c；自家排最后）。本轮只要求声明 + 能生成。 */
export const FIXTURE_SLOT_B: FixtureSlot = {
  key: 'b',
  role: 'integrator',
  packageName: FIXTURE_PACKAGE_PREFIX + 'b',
  pluginId: FIXTURE_PACKAGE_PREFIX + 'b',
  batch: {
    prefix: 'fxb',
    selfKey: 'b',
    selfOrder: 'last',
    targets: [
      { key: 'b', title: '夹具 B 本体', packageName: FIXTURE_PACKAGE_PREFIX + 'b', prefix: 'fxb-b' },
      { key: 'c', title: '夹具 C', packageName: FIXTURE_PACKAGE_PREFIX + 'c', prefix: 'fxb-c' },
    ],
  },
  selfTargetPrefix: 'fxb-b',
  description: '批量集成方（本体 + 一家目标；本体 last）',
  versions: FIXTURE_VERSION_SEQUENCE,
}

/** C：纯目标（无更新接线，只被 A/B 更新）。本轮只要求声明 + 能生成。 */
export const FIXTURE_SLOT_C: FixtureSlot = {
  key: 'c',
  role: 'target',
  packageName: FIXTURE_PACKAGE_PREFIX + 'c',
  pluginId: FIXTURE_PACKAGE_PREFIX + 'c',
  batch: null,
  selfTargetPrefix: null,
  description: '纯目标（无更新接线，只被批量集成方更新）',
  versions: FIXTURE_VERSION_SEQUENCE,
}

/** 全部席位（顺序即文档顺序，不是执行顺序）。 */
export const FIXTURE_SLOTS: readonly FixtureSlot[] = [FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_SLOT_C]

/** 全部席位包名（发布/清理时按这份清单核对，避免漏发或多发）。 */
export const FIXTURE_SLOT_PACKAGE_NAMES: readonly string[] = FIXTURE_SLOTS.map((slot) => slot.packageName)

/** 按席位键取身份（未知键立刻抛，避免「打错一个字生成出另一个包」）。 */
export function fixtureSlotOf(key: string): FixtureSlot {
  const slot = FIXTURE_SLOTS.find((candidate) => candidate.key === key)
  if (!slot) throw new Error('[fixtures] 未知席位键：' + JSON.stringify(key) + '（允许 ' + FIXTURE_SLOTS.map((s) => s.key).join('/') + '）')
  return slot
}

/** 校验版本在已声明序列里（生成/发布层的第一道闸）。 */
export function assertFixtureVersion(slot: FixtureSlot, version: string): FixtureVersion {
  const found = slot.versions.find((candidate) => candidate === version)
  if (!found) throw new Error('[fixtures] ' + slot.packageName + ' 没有声明版本 ' + JSON.stringify(version))
  return found
}

/** 包名 → 席位（发布/安装层做反查用）。 */
export function fixtureSlotOfPackage(packageName: string): FixtureSlot {
  const slot = FIXTURE_SLOTS.find((candidate) => candidate.packageName === packageName)
  if (!slot) throw new Error('[fixtures] 不是夹具包名：' + JSON.stringify(packageName))
  return slot
}

/** 可见变化（#265 场景 A 的「更新后看得见」判据；模板与场景断言共用这一份）。 */
export interface FixtureBuildTags {
  /** client half 构建期烧进去的标记，形如 'client v0.0.1'。 */
  readonly clientTag: string
  /** host half 构建期烧进去的标记，形如 'host v0.0.1'；由 buildTag 电话回报，重启后 UI 才变。 */
  readonly hostTag: string
  /** 卡片标题（变体版追加「（新版）」，纯 client 侧可见变化）。 */
  readonly cardTitle: string
  /** 根节点 data-fixture 值（= 席位键）。 */
  readonly fixtureKey: FixtureSlotKey
}

/** 一个席位 × 一个版本的可见变化标记（唯一真源；不许在别处拼 'client v'）。 */
export function fixtureBuildTagsOf(slot: FixtureSlot, version: FixtureVersion): FixtureBuildTags {
  return {
    clientTag: 'client v' + version,
    hostTag: 'host v' + version,
    cardTitle: '夹具 ' + slot.key.toUpperCase() + ' · 更新演示' + (version === FIXTURE_VARIANT_VERSION ? '（新版）' : ''),
    fixtureKey: slot.key,
  }
}

/** 夹具 host↔client 桥的 HTTP 路由（每个夹具包一条，按席位键区分）。 */
export function fixtureBridgeRouteOf(slot: FixtureSlot): string {
  return '/_dsh/selftest-fixture-' + slot.key
}

/** 夹具 host half 的「构建标记电话」：client 用它把 host 侧版本也显示出来（重启后才会变）。 */
export function fixtureBuildTagPhoneOf(slot: FixtureSlot): string {
  return slot.packageName + '.buildTag'
}

/** 本地 registry 地址的环境变量名（host half 从它读；由真机 harness 注入到被测宿主进程）。 */
export const FIXTURE_REGISTRY_ENV = 'DSH_SELFTEST_REGISTRY'

/** 被测系统（SUT）依赖：夹具依赖它，才能把更新链锻在自己身上。 */
export interface FixtureSutDependency {
  readonly name: string
  readonly version: string
}
