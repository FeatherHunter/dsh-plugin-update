/**
 * tests/batch-prefs-archive-ghost.test.mjs —— #106 prefs 幽灵对齐。
 *
 * 只测外部行为/产物：
 *  ① archive 下 prefs 开关与宏/名单行同口径（13px/6px 12px/透明底/无最小宽）；
 *  ② [x]/[ ] 状态在双主题保留可读（DOM 同份，aria-pressed 翻转）；
 *  ③ default 零回归（默认串不动、无 data-theme、无 archive 串）；
 *  ④ 深色媒体仍在位（透明底在深纸上仍靠纸墨变量）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_BATCH_PANEL_CSS,
  UPDATE_BATCH_PANEL_ARCHIVE_CSS,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js'

function rowOf(overrides = {}) {
  return {
    key: 'a',
    title: '甲插件',
    phase: 'ready',
    targetVersion: '1.2.0',
    restartRequired: false,
    error: null,
    snapshot: {
      runningVersion: '1.0.0',
      installedVersion: '1.0.0',
      latestVersion: '1.2.0',
      canInstall: true,
      blockedReason: null,
      job: null,
    },
    manual: null,
    queue: null,
    profileName: null,
    ...overrides,
  }
}

function domOf(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/, '')
}

describe('#106 archive prefs 幽灵对齐', () => {
  it('archive 串覆盖 prefs：13px/6px 12px/透明底/无最小宽', () => {
    const css = UPDATE_BATCH_PANEL_ARCHIVE_CSS
    assert.ok(
      css.includes('.dsh-upd[data-theme="archive"] .dsh-upd-batch-prefs button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0;background:transparent}'),
      'prefs 须与宏/名单行同口径（13px 紧凑、透明底、无最小宽）',
    )
  })

  it('[x]/[ ] 在双主题保留：DOM 同份、aria-pressed 翻转', () => {
    const on = domOf(renderBatchPanelHTML({ rows: [rowOf()], prefs: { checkOnOpen: true }, lang: 'zh', theme: 'archive' }))
    assert.ok(on.includes('data-act="toggle-check-on-open"'), 'archive 下开关仍在')
    assert.ok(on.includes('[x]'), '勾选态保留 [x]')
    assert.ok(on.includes('aria-pressed="true"'), '勾选态 aria-pressed=true')
    const off = domOf(renderBatchPanelHTML({ rows: [rowOf()], prefs: { checkOnOpen: false }, lang: 'zh', theme: 'archive' }))
    assert.ok(off.includes('[ ]'), '未勾选保留 [ ]')
    assert.ok(off.includes('aria-pressed="false"'), '未勾选 aria-pressed=false')
    const def = domOf(renderBatchPanelHTML({ rows: [rowOf()], prefs: { checkOnOpen: true }, lang: 'zh' }))
    assert.ok(def.includes('[x]'), 'default 下 [x] 不动')
  })

  it('default 零回归：默认串不动、默认输出无 archive', () => {
    assert.ok(!UPDATE_BATCH_PANEL_CSS.includes('dsh-upd-batch-prefs'), '默认串不许碰 prefs（只换 archive 皮肤）')
    const html = renderBatchPanelHTML({ rows: [rowOf()], prefs: { checkOnOpen: true }, lang: 'zh' })
    assert.ok(!html.includes('data-theme='), '默认不得出现 data-theme 属性')
    assert.ok(!html.includes('dsh-upd-batch-prefs button{font-size'), '默认样式不得带 prefs 覆盖串')
  })

  it('深色媒体仍在位：透明底在深纸上靠纸墨变量', () => {
    const css = UPDATE_BATCH_PANEL_ARCHIVE_CSS
    assert.ok(css.includes('@media (prefers-color-scheme: dark)'), '深色媒体须还在')
    // prefs 不独立设色：边框/文字沿用底层 archive button 的 border-strong/text，深浅跟纸墨走。
    const prefsRule = css.split('\n').find((line) => line.includes('.dsh-upd-batch-prefs button'))
    assert.ok(prefsRule, 'prefs 规则须在串里')
    assert.ok(!prefsRule.includes('color:'), 'prefs 不独立设色（沿用 --dsh-update-text 纸墨）')
    assert.ok(!prefsRule.includes('border-color'), 'prefs 不独立设边框色（沿用 --dsh-update-border-strong）')
  })
})
