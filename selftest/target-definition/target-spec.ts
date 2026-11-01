/**
 * selftest/target-definition/target-spec.ts —— 双自测目标的唯一真源（数据层，零 IO）。
 *
 * 对照域词（见根 CONTEXT.md）：这里的“目标包”就是 `src/core/reader.ts` 里
 * `resolveTargetPackage(targetName)` 要解析的那个包名。本文件只回答“测谁”，
 * 不回答“怎么装”“从哪查新版”（那是 scenario-harness 的端口的事）。
 *
 * 设计：
 * - 数据结构：`FixtureTargetSpec` 是只读记录（immutable record），`TARGET_PAIR` 是只读二元组；
 *   版本序列是冻结数组，越界即抛（fail-fast），不静默截断。
 * - 模式：Factory（`createTargetSpec` 收敛 slot → 完整规约，调用方拿不到半成品）。
 */

const SELFTEST_TARGET_PREFIX = 'dsh-plugin-update-selftest-target-'

/** 自测槽位：恰好两个——`a` 单测主角，`b` 批量对照组；第三个槽位不存在（见 README 非目标）。 */
export type SelftestSlot = 'a' | 'b'

/** 目标规约：名字是 npm 包名文法（全小写，见宿主契约 PACKAGE_NAME），描述首句固定 TEST ONLY。 */
export interface FixtureTargetSpec {
  readonly slot: SelftestSlot
  readonly name: string
  readonly description: string
}

/** 夹具版本序列（B 档本地闭环用；C 档真发 npm 时沿用同一序列往后增，不与主包版本耦合）。 */
export const FIXTURE_VERSION_SEQUENCE = ['0.0.1', '0.0.2'] as const

export type FixtureVersion = (typeof FIXTURE_VERSION_SEQUENCE)[number]

function specFor(slot: SelftestSlot): FixtureTargetSpec {
  return {
    slot,
    name: `${SELFTEST_TARGET_PREFIX}${slot}`,
    description: `TEST ONLY selftest target ${slot} for dsh-plugin-update (not a real plugin).`,
  }
}

/** 工厂：唯一构造入口；slot 非法即抛，不返回“看起来像但名字不对”的规约。 */
export function createTargetSpec(slot: SelftestSlot): FixtureTargetSpec {
  if (slot !== 'a' && slot !== 'b') {
    throw new Error(`[selftest] unknown slot: ${String(slot)} (want 'a' | 'b')`)
  }
  return specFor(slot)
}

/** 双目标：顺序固定 `[a, b]`（批量场景按此顺序推进，保证确定性；见 scenario-runner）。 */
export const TARGET_A: FixtureTargetSpec = specFor('a')
export const TARGET_B: FixtureTargetSpec = specFor('b')
export const TARGET_PAIR: readonly [FixtureTargetSpec, FixtureTargetSpec] = [TARGET_A, TARGET_B]

/** 守卫：名字必须恰好是双目标之一（防把主包或外部插件误当靶子）。 */
export function isSelftestTarget(name: string): name is FixtureTargetSpec['name'] {
  return name === TARGET_A.name || name === TARGET_B.name
}

/** 断言式守卫：不是自测目标即抛（harness 在 setup 阶段调用，早失败早停）。 */
export function assertSelftestTarget(name: string): asserts name is FixtureTargetSpec['name'] {
  if (!isSelftestTarget(name)) {
    throw new Error(`[selftest] not a selftest target: ${name} (want ${TARGET_A.name} | ${TARGET_B.name})`)
  }
}
