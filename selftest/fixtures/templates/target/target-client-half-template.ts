/**
 * selftest/fixtures/templates/target/target-client-half-template.ts —— 纯目标 client half 的 TS 源模板。
 *
 * 左下角常驻一枚「本包已加载 + 构建标记」的徽标：T2 跑批量场景时，
 * 它能证明 C 也被真加载了、且 C 的版本真的换了（不抢 A/B 的批量卡片位置）。
 * 它**不带任何更新 UI**（#258 §6 C 席位）：没有 .dsh-upd、没有更新入口/面板，
 * 根节点写死 data-update-wiring="none"，场景 c 就按这个属性断言「纯目标不建 hub」。
 */
import type { FixtureBuildTags, FixtureSlot, FixtureVariantEffect } from '../../identity/fixture-slots.ts'

/** 纯目标 client half 的渲染入参。 */
export interface TargetClientHalfInputs {
  readonly slot: FixtureSlot
  readonly version: string
  readonly buildTags: FixtureBuildTags
  /** 版本变体效果（目标侧只有标题后缀有意义；更新接线永远不建）。 */
  readonly effect?: FixtureVariantEffect
}

/** 卡片定位样式（身份单源的位置）。 */
function placementStyle(slot: FixtureSlot): string {
  const parts: string[] = []
  if (slot.overlay.right !== undefined) parts.push('right: ' + slot.overlay.right)
  if (slot.overlay.left !== undefined) parts.push('left: ' + slot.overlay.left)
  if (slot.overlay.top !== undefined) parts.push('top: ' + slot.overlay.top)
  if (slot.overlay.bottom !== undefined) parts.push('bottom: ' + slot.overlay.bottom)
  parts.push('width: ' + slot.overlay.width)
  return '{ position: ' + "'fixed'" + ', ' + parts.join(', ') + ", zIndex: 2147483000, pointerEvents: 'auto', background: '#eef7ee', color: '#12301a', border: '1px solid rgba(32,120,64,.45)', borderRadius: 10, padding: '6px 10px', fontSize: 12, boxShadow: '0 8px 24px rgba(0,0,0,.2)' }"
}

/** 渲染纯目标 client half 的 TypeScript 源码。 */
export function renderTargetClientHalf(inputs: TargetClientHalfInputs): string {
  const { slot, version, buildTags } = inputs
  if (slot.role !== 'target') {
    throw new Error('[fixtures] 席位 ' + slot.key + ' 不是纯目标，不能渲染纯目标 client half')
  }
  const effect = inputs.effect ?? { ui: 'single' as const, titleSuffix: version === '0.0.2' ? '（新版）' : '', hubDock: false, hostBehavior: null, seatLine: '' }
  const badgeText = '夹具 ' + slot.key.toUpperCase() + ' · ' + buildTags.clientTag + effect.titleSuffix
  return [
    '// [TEST ONLY] 夹具纯目标 client half（#266 生成产物，勿手改；源模板 = selftest/fixtures/templates/target）',
    'declare function require(id: string): any',
    'declare const exports: any',
    '',
    "const React = require('react')",
    'const PLUGIN_ID = ' + "'" + slot.pluginId + "'",
    'const BUILD_TAG = ' + "'" + buildTags.clientTag + "'",
    'const FIXTURE_KEY = ' + "'" + buildTags.fixtureKey + "'",
    'const BADGE_TEXT = ' + "'" + badgeText.replace(/'/g, "\\'") + "'",
    '',
    '// 纯目标：故意不 require dsh-plugin-update 的任何子路径，也不挂任何更新入口/面板。',
    'function TargetBadge() {',
    "  return React.createElement('div', {",
    "    className: 'dsh-fixture-card dsh-fixture-target',",
    "    'data-fixture': FIXTURE_KEY,",
    "    'data-fixture-ui': 'none',",
    "    'data-update-wiring': 'none',",
    "    'data-build-tag': BUILD_TAG,",
    '    style: ' + placementStyle(slot) + ',',
    '  }, BADGE_TEXT)',
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
