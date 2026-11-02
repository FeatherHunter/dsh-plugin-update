/**
 * selftest/fixtures/templates/integrator/integrator-client-half-template.ts —— 批量集成方 client half 的 TS 源模板。
 *
 * 生成物落在夹具包的 src/client.ts，再由 esbuild 打成 lib/client.js（CJS + window.__ModuleLoader__.load 包壳）。
 * 两种卡片布局（由场景声明的 effect.ui 决定；模板/发布器/场景都不硬编码版本）：
 *   - 'single'：T1 单包主链布局（单插件入口 + 单插件面板），供 T1 场景 A 复跑；
 *   - 'batch' ：#266 批量布局（批量入口 + 批量面板 + 可选中枢进度坞），两个批量集成方各挂一份。
 * 可见变化由 effect 决定：titleSuffix / hubDock / hostBehavior（真 host 回复里的新字段）/ seatLine。
 */
import type { FixtureBuildTags, FixtureSlot, FixtureVariantEffect } from '../../identity/fixture-slots.ts'
import { fixtureBridgeRouteOf, fixtureBuildTagPhoneOf } from '../../identity/fixture-slots.ts'

/** 集成方 client half 的渲染入参。 */
export interface IntegratorClientHalfInputs {
  readonly slot: FixtureSlot
  readonly version: string
  readonly buildTags: FixtureBuildTags
  /** 版本变体效果（缺省 = T1 单面板效果；模板不许自己写死「新版」）。 */
  readonly effect?: FixtureVariantEffect
}

/** 单引号包一层（身份值都是简单字面量）。 */
function quote(value: string): string {
  return "'" + value + "'"
}

/** 卡片定位样式（三个夹具同窗口时按身份单源的位置摆放，互不遮挡）。 */
function placementStyle(slot: FixtureSlot): string {
  const parts: string[] = []
  if (slot.overlay.right !== undefined) parts.push('right: ' + slot.overlay.right)
  if (slot.overlay.left !== undefined) parts.push('left: ' + slot.overlay.left)
  if (slot.overlay.top !== undefined) parts.push('top: ' + slot.overlay.top)
  if (slot.overlay.bottom !== undefined) parts.push('bottom: ' + slot.overlay.bottom)
  parts.push('width: ' + slot.overlay.width)
  return '{ position: ' + quote('fixed') + ', ' + parts.join(', ') + ", zIndex: 2147483000, pointerEvents: 'auto', background: '#fffbe8', color: '#1f1a0a', border: '1px solid rgba(160,120,32,.45)', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,.28)', padding: 10, maxHeight: '84vh', overflow: 'auto' }"
}

/** 渲染集成方 client half 的 TypeScript 源码。 */
export function renderIntegratorClientHalf(inputs: IntegratorClientHalfInputs): string {
  const { slot, version, buildTags } = inputs
  if (slot.role !== 'integrator' || !slot.selfTargetPrefix) {
    throw new Error('[fixtures] 席位 ' + slot.key + ' 不是集成方，不能渲染集成方 client half')
  }
  const effect: FixtureVariantEffect = inputs.effect ?? {
    ui: 'single',
    titleSuffix: version === '0.0.2' ? '（新版）' : '',
    hubDock: false,
    hostBehavior: null,
    seatLine: '',
  }
  const seatLineLiteral = effect.seatLine === '' ? 'null' : quote(effect.seatLine)
  const behaviorText = effect.hostBehavior === null ? '宿主行为 无（v1）' : '宿主行为 ' + effect.hostBehavior
  const batchMode = effect.ui === 'batch'
  // #274 K 组：可选挂载分支（字段缺省时生成代码与旧产物一致，旧场景复跑不漂移）。
  const extraTarget =
    effect.extraSinglePanelTargetKey === undefined || slot.batch === null
      ? null
      : slot.batch.targets.find((target) => target.key === effect.extraSinglePanelTargetKey) ?? null
  if (effect.extraSinglePanelTargetKey !== undefined && extraTarget === null) {
    throw new Error('[fixtures] 席位 ' + slot.key + ' 的批量目标表里没有 ' + JSON.stringify(effect.extraSinglePanelTargetKey))
  }
  if (effect.installButton === true && batchMode) throw new Error('[fixtures] installButton 只支持 single 布局（#274）')
  if (extraTarget !== null && batchMode) throw new Error('[fixtures] extraSinglePanelTargetKey 只支持 single 布局（#274）')
  const requires = batchMode
    ? [
        "const { mountUpdateBatchPanel, mountHubProgressDock } = require('dsh-plugin-update/panel-batch')",
        "const { mountUpdateBatchEntry } = require('dsh-plugin-update/entry-batch')",
      ]
    : [
        "const { mountUpdatePanel } = require('dsh-plugin-update/panel')",
        "const { mountUpdateEntry } = require('dsh-plugin-update/entry')",
        ...(effect.installButton === true ? ["const { mountInstallButton } = require('dsh-plugin-update/install-button')"] : []),
      ]
  const buildTagEffectLines = [
    '    let alive = true',
    "    call(BUILD_TAG_PHONE, {}).then((reply: any) => {",
    "      if (alive && reply && typeof reply.buildTag === 'string') setHostTag(reply.buildTag)",
    "      if (alive && reply && 'behavior' in reply) setBehavior(typeof reply.behavior === 'string' ? reply.behavior : null)",
    '    }).catch(() => {})',
  ]
  const batchPanelOptions =
    "{ prefix: BATCH_PREFIX, call, mode: 'embedded', autoCheck: false, pollMs: 2000" +
    (effect.batchAutoResume === undefined ? '' : ', autoResume: ' + (effect.batchAutoResume ? 'true' : 'false')) +
    ' }'
  const singleHostLines: string[] = [
    "    const entryHost = document.createElement('div')",
    "    const panelHost = document.createElement('div')",
  ]
  if (effect.installButton === true) singleHostLines.push("    const buttonHost = document.createElement('div')")
  if (extraTarget !== null) singleHostLines.push("    const extraPanelHost = document.createElement('div')")
  const appendedHosts = ['entryHost', 'panelHost']
  if (effect.installButton === true) appendedHosts.push('buttonHost')
  if (extraTarget !== null) appendedHosts.push('extraPanelHost')
  singleHostLines.push(
    '    element.append(' + appendedHosts.join(', ') + ')',
    "    const entry = mountUpdateEntry(entryHost, { pluginId: PLUGIN_ID, prefix: PREFIX, call, variant: 'badge', openOn: 'always', autoCheck: 'never' })",
    "    const panel = mountUpdatePanel(panelHost, { pluginId: PLUGIN_ID, prefix: PREFIX, call, mode: 'embedded', autoCheck: false, pollMs: 5000 })",
  )
  if (effect.installButton === true) {
    singleHostLines.push("    const installButton = mountInstallButton(buttonHost, { pluginId: PLUGIN_ID, prefix: PREFIX, call, autoCheck: 'never', pollMs: 5000 })")
  }
  if (extraTarget !== null) {
    singleHostLines.push(
      '    const extraPanel = mountUpdatePanel(extraPanelHost, { pluginId: ' + quote(extraTarget.packageName) + ', prefix: ' + quote(extraTarget.prefix) + ", call, mode: 'embedded', autoCheck: false, pollMs: 5000 })",
    )
  }
  singleHostLines.push(
    ...buildTagEffectLines,
    '    return () => {',
    '      alive = false',
    '      try { entry.unmount() } catch (error) {}',
    '      try { panel.unmount() } catch (error) {}',
  )
  if (effect.installButton === true) singleHostLines.push('      try { installButton.unmount() } catch (error) {}')
  if (extraTarget !== null) singleHostLines.push('      try { extraPanel.unmount() } catch (error) {}')
  singleHostLines.push("      element.innerHTML = ''", '    }')
  const bodyLines = batchMode
    ? [
        "    const entryHost = document.createElement('div')",
        "    const panelHost = document.createElement('div')",
        "    const dockHost = document.createElement('div')",
        "    dockHost.setAttribute('data-fixture-dock', HUB_DOCK ? 'hub-dock' : 'none')",
        '    element.append(entryHost, panelHost, dockHost)',
        "    const entry = mountUpdateBatchEntry(entryHost, { prefix: BATCH_PREFIX, call, variant: 'button', openOn: 'always', autoCheck: 'never' })",
        '    const panel = mountUpdateBatchPanel(panelHost, ' + batchPanelOptions + ')',
        "    const dock = HUB_DOCK ? mountHubProgressDock(dockHost, { prefix: BATCH_PREFIX, call, title: '更新进度', mountAs: 'inline', hideWhenIdle: false, pollMs: 1500 }) : null",
        ...buildTagEffectLines,
        '    return () => {',
        '      alive = false',
        '      try { entry.unmount() } catch (error) {}',
        '      try { panel.unmount() } catch (error) {}',
        '      if (dock) { try { dock.unmount() } catch (error) {} }',
        "      element.innerHTML = ''",
        '    }',
      ]
    : singleHostLines
  return [
    '// [TEST ONLY] 夹具 client half（#266 生成产物，勿手改；源模板 = selftest/fixtures/templates/integrator）',
    'declare function require(id: string): any',
    'declare const document: any',
    'declare const exports: any',
    '',
    "const React = require('react')",
    ...requires,
    '',
    'const PLUGIN_ID = ' + quote(slot.pluginId),
    'const PREFIX = ' + quote(slot.selfTargetPrefix),
    'const BATCH_PREFIX = ' + quote(slot.batch === null ? '' : slot.batch.prefix),
    'const ROUTE = ' + quote(fixtureBridgeRouteOf(slot)),
    'const BUILD_TAG_PHONE = ' + quote(fixtureBuildTagPhoneOf(slot)),
    'const BUILD_TAG = ' + quote(buildTags.clientTag),
    'const CARD_TITLE = ' + quote(buildTags.cardTitle),
    'const FIXTURE_KEY = ' + quote(buildTags.fixtureKey),
    'const UI_MODE = ' + quote(effect.ui),
    'const SEAT_LINE = ' + seatLineLiteral,
    'const HOST_BEHAVIOR_TEXT = ' + quote(behaviorText),
    'const HUB_DOCK = ' + (effect.hubDock ? 'true' : 'false'),
    ...(extraTarget === null ? [] : [
      'const EXTRA_PLUGIN_ID = ' + quote(extraTarget.packageName),
      'const EXTRA_PREFIX = ' + quote(extraTarget.prefix),
    ]),
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
    "  const [behavior, setBehavior] = React.useState(null)",
    '  React.useEffect(() => {',
    '    const element = hostRef.current',
    '    if (!element) return undefined',
    ...bodyLines,
    '  }, [])',
    '  const children = [',
    "    React.createElement('div', { key: 'title', 'data-fixture-section': 'title', style: { fontSize: 12, fontWeight: 600, margin: '0 0 2px 2px' } }, CARD_TITLE),",
    "    React.createElement('div', { key: 'build', 'data-fixture-build-tag': BUILD_TAG, style: { fontSize: 11, opacity: 0.7, margin: '0 0 2px 2px' } }, BUILD_TAG),",
    "    React.createElement('div', { key: 'host', 'data-fixture-host-tag': hostTag, style: { fontSize: 11, opacity: 0.7, margin: '0 0 2px 2px' } }, hostTag),",
    '    React.createElement(\'div\', {',
    "      key: 'seat',",
    "      'data-fixture-seat-line': SEAT_LINE === null ? 'none' : SEAT_LINE,",
    "      style: { fontSize: 11, opacity: 0.75, margin: '0 0 2px 2px' },",
    "    }, SEAT_LINE === null ? '单席位集成方（无批量席位行）' : SEAT_LINE),",
    '    React.createElement(\'div\', {',
    "      key: 'behavior',",
    "      'data-fixture-behavior': behavior === null ? 'none' : behavior,",
    "      'data-fixture-behavior-text': HOST_BEHAVIOR_TEXT,",
    "      style: { fontSize: 11, opacity: 0.75, margin: '0 0 8px 2px' },",
    '    }, HOST_BEHAVIOR_TEXT),',
    "    React.createElement('div', { key: 'hostref', ref: hostRef }),",
    '  ]',
    "  return React.createElement('div', {",
    "    className: 'dsh-fixture-card',",
    "    'data-fixture': FIXTURE_KEY,",
    "    'data-fixture-ui': UI_MODE,",
    "    'data-build-tag': BUILD_TAG,",
    '    style: ' + placementStyle(slot) + ',',
    '  }, children)',
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
