/**
 * selftest/fixtures/templates/target/target-host-half-template.ts —— 纯目标 host half 的 TS 源模板。
 *
 * 纯目标没有更新接线（#258 §6 C 席位）：它只证明「一个普通可安装插件能被 A 批量更新」。
 * 生成的 lib/index.js 必须是合法的 cordis 插件模块（name/apply），否则 patch insert 加载会报错。
 */
import type { FixtureBuildTags, FixtureSlot } from '../../identity/fixture-slots.ts'

/** 纯目标 host half 的渲染入参。 */
export interface TargetHostHalfInputs {
  readonly slot: FixtureSlot
  readonly version: string
  readonly buildTags: FixtureBuildTags
}

/** 渲染纯目标 host half 的 TypeScript 源码。 */
export function renderTargetHostHalf(inputs: TargetHostHalfInputs): string {
  const { slot, buildTags } = inputs
  if (slot.role !== 'target') {
    throw new Error('[fixtures] 席位 ' + slot.key + ' 不是纯目标，不能渲染纯目标 host half')
  }
  return [
    '// [TEST ONLY] 夹具纯目标 host half（#265 生成产物，勿手改；源模板 = selftest/fixtures/templates/target）',
    'export const name = ' + "'" + slot.packageName + "'",
    'export const inject: string[] = []',
    'export const BUILD_TAG = ' + "'" + buildTags.hostTag + "'",
    '',
    '// 纯目标不注册电话、不连更新链：只求被宿主当作普通插件加载成功。',
    'export function apply(): void {}',
    '',
  ].join('\n')
}
