/**
 * selftest/fixtures/templates/target/target-client-half-template.ts —— 纯目标 client half 的 TS 源模板。
 *
 * 左下角常驻一枚「本包已加载 + 构建标记」的徽标：T2 跑批量场景时，
 * 它能证明 C 也被真加载了、且 C 的版本真的换了（不抢 A 的右下角面板位置）。
 */
import type { FixtureBuildTags, FixtureSlot } from '../../identity/fixture-slots.ts'

/** 纯目标 client half 的渲染入参。 */
export interface TargetClientHalfInputs {
  readonly slot: FixtureSlot
  readonly version: string
  readonly buildTags: FixtureBuildTags
}

/** 渲染纯目标 client half 的 TypeScript 源码。 */
export function renderTargetClientHalf(inputs: TargetClientHalfInputs): string {
  const { slot, buildTags } = inputs
  if (slot.role !== 'target') {
    throw new Error('[fixtures] 席位 ' + slot.key + ' 不是纯目标，不能渲染纯目标 client half')
  }
  return [
    '// [TEST ONLY] 夹具纯目标 client half（#265 生成产物，勿手改；源模板 = selftest/fixtures/templates/target）',
    'declare function require(id: string): any',
    'declare const exports: any',
    '',
    "const React = require('react')",
    'const PLUGIN_ID = ' + "'" + slot.pluginId + "'",
    'const BUILD_TAG = ' + "'" + buildTags.clientTag + "'",
    'const FIXTURE_KEY = ' + "'" + buildTags.fixtureKey + "'",
    '',
    'function TargetBadge() {',
    "  return React.createElement('div', {",
    "    className: 'dsh-fixture-card dsh-fixture-target',",
    "    'data-fixture': FIXTURE_KEY,",
    "    'data-build-tag': BUILD_TAG,",
    '    style: { position: ' + "'fixed'" + ', left: 16, bottom: 16, zIndex: 2147483000, pointerEvents: ' + "'auto'" + ", background: '#eef7ee', color: '#12301a', border: '1px solid rgba(32,120,64,.45)', borderRadius: 10, padding: '6px 10px', fontSize: 12, boxShadow: '0 8px 24px rgba(0,0,0,.2)' },",
    "  }, '夹具 ' + FIXTURE_KEY.toUpperCase() + ' · ' + BUILD_TAG)",
    '}',
    '',
    'function apply(ctx: any): void {',
    "  ctx.slots.inject('shell.overlay', () => ctx.slots.register({",
    "    name: 'shell.overlay',",
    "    id: PLUGIN_ID + '-overlay',",
    '    label: () => PLUGIN_ID,',
    '  }, () => React.createElement(TargetBadge)))',
    '}',
    '',
    "const inject = ['slots']",
    'exports.apply = apply',
    'exports.inject = inject',
    '',
  ].join('\n')
}
