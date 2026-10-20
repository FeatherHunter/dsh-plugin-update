/**
 * tests/issue-240-batch-dialog-height-contract.test.mjs —— 批量弹窗高度契约（#240）。
 *
 * 现象：web profile 矮窗（CSS 高 ≤ 约 636）打开「更新档案·总账」批量弹窗，失败横幅被压成
 * 3.4em 的红框，「复制诊断 / 复制手工命令」越出框外。根因：批量弹窗根没有 .dsh-upd-body
 * 滚动区，内核 #93 弹窗契约（:has(>.dsh-upd-body)）刻意不覆盖它；内容高过 85vh 时纵向 flex
 * 按比例压子项，唯独显式 min-height:3.4em 的横幅先被压到地板。
 *
 * 本仓风格：断 CSS 串 + DOM 形状（真实盒子由 headless 探针量：见 #240 票内记录），
 * 守的是"契约本身还在不在"：
 *   1. 批量弹窗自己滚（overflow-y:auto），child 一律 flex:none，不再被压扁；
 *   2. 契约只挂弹窗作用域，且只认批量根（说不含 .dsh-upd-body 的帧）；
 *   3. 内核 #93 契约仍只管带滚动区的弹窗帧，不扩到批量面板；
 *   4. embedded 批量面板输出与旧版一致（无 overlay）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UPDATE_BATCH_PANEL_CSS, renderBatchPanelHTML } from '../dist/panel-batch.js'
import { UPDATE_PANEL_CSS } from '../dist/panel.js'

/** 契约两行（与 src/panel/batch/styles.ts 同一字符串；形状改了这里就该红）。 */
const BATCH_SCROLL_RULE = '.dsh-upd-overlay .dsh-upd.dsh-upd-batch{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}'
const BATCH_FRAME_RULE = '.dsh-upd-overlay .dsh-upd.dsh-upd-batch>*{flex:none}'

function rowOf(overrides = {}) {
  return {
    key: 'bill',
    title: '饼干记账',
    phase: 'ready',
    targetVersion: '1.2.0',
    restartRequired: false,
    error: null,
    manual: null,
    queue: null,
    profileName: 'web',
    snapshot: {
      runningVersion: '0.0.0',
      installed: false,
      installedVersion: null,
      latestVersion: '1.2.0',
      canInstall: true,
      blockedReason: null,
      registered: true,
      job: null,
    },
    ...overrides,
  }
}

function render(rows, mode = 'dialog') {
  return renderBatchPanelHTML({ rows, theme: 'archive', loaded: true, titles: {}, lang: 'zh', mode })
}

/** 去掉 <style>，只看 DOM。 */
function domOf(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/g, '')
}

describe('#240 批量弹窗高度契约', () => {
  test('批量弹窗自己滚、child 不吃收缩：两条契约都在 CSS 里', () => {
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes(BATCH_SCROLL_RULE), '批量弹窗根须把纵向溢出交给自身滚动（横向仍 hidden）')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes(BATCH_FRAME_RULE), '批量弹窗内 child 不得被纵向 flex 压扁')
  })

  test('契约作用域：只挂 .dsh-upd-overlay，只认批量根（无 .dsh-upd-body 的帧）', () => {
    for (const rule of [BATCH_SCROLL_RULE, BATCH_FRAME_RULE]) {
      assert.ok(rule.startsWith('.dsh-upd-overlay '), rule + ' 必须以 .dsh-upd-overlay 起头（embedded 不吃）')
      assert.ok(rule.includes('.dsh-upd.dsh-upd-batch'), rule + ' 必须只认批量根（内核面板有滚动区，不吃本契约）')
      assert.ok(!rule.includes(':has(>'), rule + ' 不得借用内核 :has(>.dsh-upd-body) 判据（批量根根本没有滚动区）')
    }
  })

  test('内核 #93 契约仍只管带滚动区的弹窗帧，不扩到批量面板', () => {
    assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body)>:not(.dsh-upd-body){flex:none}'),
      '#93 帧契约仍在，且判据仍是 :has(>.dsh-upd-body)')
    assert.ok(!UPDATE_PANEL_CSS.includes('.dsh-upd.dsh-upd-batch'),
      '批量面板的高度契约归批量域（src/panel/batch/styles.ts），内核 CSS 里不许出现批量专属选择器')
  })

  test('dialog 形态：批量根被 overlay 包住，契约随样式一起下发', () => {
    const html = render([rowOf({ phase: 'failed', error: 'recovery-required' })])
    const dom = domOf(html)
    assert.ok(dom.includes('<div class="dsh-upd-overlay" data-mode="dialog">'), 'dialog 形态必须先有 overlay 包裹')
    assert.match(dom, /<div class="dsh-upd dsh-upd-batch"[^>]*>/, 'dialog 根是批量面板本体')
    assert.ok(html.includes(BATCH_SCROLL_RULE), '下发给页面的样式里必须带批量弹窗滚动契约')
    assert.ok(html.includes(BATCH_FRAME_RULE), '下发给页面的样式里必须带 child 不收缩契约')
  })

  test('批量根没有 .dsh-upd-body 滚动区（这正是 #93 契约排除它的原因）', () => {
    const dom = domOf(render([rowOf({ phase: 'failed', error: 'recovery-required' })]))
    const rootAt = dom.indexOf('<div class="dsh-upd dsh-upd-batch"')
    assert.ok(rootAt >= 0, '批量根必须存在')
    const root = dom.slice(rootAt)
    assert.ok(!root.includes('class="dsh-upd-body"'), '批量面板不得长出 .dsh-upd-body（否则本条契约就该退役）')
    assert.ok(root.startsWith('<div class="dsh-upd dsh-upd-batch"'), '批量根的 class 顺序保持 dsh-upd dsh-upd-batch')
  })

  test('失败横幅形状不变：bulk 失败行仍渲染红横幅 + 复制按钮组', () => {
    const dom = domOf(render([rowOf({ phase: 'failed', error: 'recovery-required' })]))
    assert.ok(dom.includes('data-kind="failed"'), '失败横幅仍在')
    assert.ok(dom.includes('.dsh-upd-bcopy') || dom.includes('dsh-upd-bcopy'), '失败横幅里的复制按钮组仍在')
  })

  test('embedded 形态与旧版一致：不带 overlay 包裹，但契约样式仍随面板下发', () => {
    const html = render([rowOf()], 'embedded')
    const dom = domOf(html)
    assert.ok(!dom.includes('dsh-upd-overlay" data-mode="dialog"'), 'embedded 不该出现 dialog overlay')
    assert.ok(html.includes(BATCH_SCROLL_RULE), '样式照旧下发（选择器带 overlay 前缀，embedded 天然不吃）')
    assert.match(dom, /^\s*<div class="dsh-upd dsh-upd-batch"/, 'embedded 根就是批量面板本身')
  })
})
