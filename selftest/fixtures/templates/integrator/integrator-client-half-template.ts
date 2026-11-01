/**
 * selftest/fixtures/templates/integrator/integrator-client-half-template.ts —— 批量集成方 client half 的 TS 源模板。
 *
 * 生成物落在夹具包的 src/client.ts，再由 esbuild 打成 lib/client.js（CJS + window.__ModuleLoader__.load 包壳）。
 * 内容：
 *   1. 挂 shell.overlay 常驻卡片（自己根节点写 pointer-events:auto，exploration 已验证）；
 *   2. 卡片里同时挂 SUT 的入口件（mountUpdateEntry）与面板（mountUpdatePanel），前缀 = 本席位「自己」的目标前缀；
 *   3. 卡片标题/构建标记随版本变化（真 UI 可见变化），host 标记经桥取回（重启后才变，证明 host 代码也换了）。
 */
import type { FixtureBuildTags, FixtureSlot } from '../../identity/fixture-slots.ts'
import { fixtureBridgeRouteOf, fixtureBuildTagPhoneOf } from '../../identity/fixture-slots.ts'

/** 集成方 client half 的渲染入参。 */
export interface IntegratorClientHalfInputs {
  readonly slot: FixtureSlot
  readonly version: string
  readonly buildTags: FixtureBuildTags
}

/** 单引号包一层（身份值都是简单字面量）。 */
function quote(value: string): string {
  return "'" + value + "'"
}

/** 渲染集成方 client half 的 TypeScript 源码。 */
export function renderIntegratorClientHalf(inputs: IntegratorClientHalfInputs): string {
  const { slot, buildTags } = inputs
  if (slot.role !== 'integrator' || !slot.selfTargetPrefix) {
    throw new Error('[fixtures] 席位 ' + slot.key + ' 不是集成方，不能渲染集成方 client half')
  }
  return [
    '// [TEST ONLY] 夹具 client half（#265 生成产物，勿手改；源模板 = selftest/fixtures/templates/integrator）',
    'declare function require(id: string): any',
    'declare const document: any',
    'declare const exports: any',
    '',
    "const React = require('react')",
    "const { mountUpdatePanel } = require('dsh-plugin-update/panel')",
    "const { mountUpdateEntry } = require('dsh-plugin-update/entry')",
    '',
    'const PLUGIN_ID = ' + quote(slot.pluginId),
    'const PREFIX = ' + quote(slot.selfTargetPrefix),
    'const ROUTE = ' + quote(fixtureBridgeRouteOf(slot)),
    'const BUILD_TAG_PHONE = ' + quote(fixtureBuildTagPhoneOf(slot)),
    'const BUILD_TAG = ' + quote(buildTags.clientTag),
    'const CARD_TITLE = ' + quote(buildTags.cardTitle),
    'const FIXTURE_KEY = ' + quote(buildTags.fixtureKey),
    '',
    'async function call(phone: string, args: any): Promise<any> {',
    '  const response = await fetch(ROUTE, {',
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    '    body: JSON.stringify({ phone, args: args || {} }),',
    '  })',
    '  const body = await response.json().catch(() => null)',
    "  if (!body || body.ok !== true) throw new Error((body && body.error) || 'fixture bridge failed')",
    '  return body.reply',
    '}',
    '',
    'function FixtureCard() {',
    '  const hostRef = React.useRef(null)',
    "  const [hostTag, setHostTag] = React.useState('host ?')",
    '  React.useEffect(() => {',
    '    const element = hostRef.current',
    '    if (!element) return undefined',
    "    const entryHost = document.createElement('div')",
    "    const panelHost = document.createElement('div')",
    '    element.append(entryHost, panelHost)',
    "    const entry = mountUpdateEntry(entryHost, { pluginId: PLUGIN_ID, prefix: PREFIX, call, variant: 'badge', openOn: 'always', autoCheck: 'never' })",
    "    const panel = mountUpdatePanel(panelHost, { pluginId: PLUGIN_ID, prefix: PREFIX, call, mode: 'embedded', autoCheck: false, pollMs: 5000 })",
    '    let alive = true',
    '    call(BUILD_TAG_PHONE, {}).then((reply: any) => {',
    "      if (alive && reply && typeof reply.buildTag === 'string') setHostTag(reply.buildTag)",
    '    }).catch(() => {})',
    '    return () => {',
    '      alive = false',
    '      try { entry.unmount() } catch (error) {}',
    '      try { panel.unmount() } catch (error) {}',
    "      element.innerHTML = ''",
    '    }',
    '  }, [])',
    "  return React.createElement('div', {",
    "    className: 'dsh-fixture-card',",
    "    'data-fixture': FIXTURE_KEY,",
    "    'data-build-tag': BUILD_TAG,",
    '    style: { position: ' + quote('fixed') + ', right: 16, bottom: 16, width: 460, zIndex: 2147483000, pointerEvents: ' + quote('auto') + ", background: '#fffbe8', color: '#1f1a0a', border: '1px solid rgba(160,120,32,.45)', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,.28)', padding: 10, maxHeight: '76vh', overflow: 'auto' },",
    '  },',
    "    React.createElement('div', { 'data-fixture-section': 'title', style: { fontSize: 12, fontWeight: 600, margin: '0 0 2px 2px' } }, CARD_TITLE),",
    "    React.createElement('div', { 'data-fixture-build-tag': BUILD_TAG, style: { fontSize: 11, opacity: 0.7, margin: '0 0 2px 2px' } }, BUILD_TAG),",
    "    React.createElement('div', { 'data-fixture-host-tag': hostTag, style: { fontSize: 11, opacity: 0.7, margin: '0 0 8px 2px' } }, hostTag),",
    "    React.createElement('div', { ref: hostRef }))",
    '}',
    '',
    'function apply(ctx: any): void {',
    "  ctx.slots.inject('shell.overlay', () => ctx.slots.register({",
    "    name: 'shell.overlay',",
    "    id: PLUGIN_ID + '-overlay',",
    '    label: () => PLUGIN_ID,',
    '  }, () => React.createElement(FixtureCard)))',
    '}',
    '',
    "const inject = ['slots']",
    'exports.apply = apply',
    'exports.inject = inject',
    '',
  ].join('\n')
}
