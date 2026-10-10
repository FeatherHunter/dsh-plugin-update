/**
 * tests/panel-host-css-hermetic.test.mjs —— 宿主样式隔离（章节标题不变紫）。
 *
 * 现场：实际 DSH 里 01–05 章节标题被染成紫蓝渐变字，而档案卷要求颜色完全自己说了算。
 * 根因：章节标题是裸 h3，内核/皮肤两处都只写字号边距、不写颜色；继承来的根颜色
 * 输给宿主全局 h3 规则的直接命中（渐变字经典三件套：background 渐变 + background-clip:text
 * + color:transparent）。交叉证据：同行的 .dsh-upd-chap-no 因显式写了颜色而安然无恙。
 * 这里守的是：h3 标题必须有双 class 颜色钉死 + 背景裁剪清洗，且渲染出的 h3 确实挂该类。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UPDATE_PANEL_CSS, renderUpdatePanelHTML } from '../dist/panel.js'

function baseInput(overrides = {}) {
  return {
    snapshot: {
      runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0',
      canInstall: true, blockedReason: null, job: null,
    },
    manual: null,
    queue: { busy: false, owner: null, waiting: [], position: null },
    skippedLatest: false,
    lastError: null,
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
    mode: 'embedded',
    ...overrides,
  }
}

describe('宿主样式隔离：章节标题 h3 不吃宿主渐变字', () => {
  test('内核钉死标题颜色：双 class + 变量正文色', () => {
    assert.ok(
      UPDATE_PANEL_CSS.includes('.dsh-upd .dsh-upd-chap-title{color:var(--dsh-update-text,#1f2937);'),
      '标题颜色须走正文变量（深色宿主即近白，档案卷跟纸墨变量）',
    )
  })

  test('内核清洗渐变字三件套：背景 + 裁剪 + 填充', () => {
    const at = UPDATE_PANEL_CSS.indexOf('.dsh-upd .dsh-upd-chap-title{')
    assert.ok(at >= 0, '须有标题隔离规则')
    const end = UPDATE_PANEL_CSS.indexOf('}', at)
    const rule = UPDATE_PANEL_CSS.slice(at, end + 1)
    assert.ok(rule.includes('background:none'), '须洗掉宿主渐变背景：' + rule)
    assert.ok(rule.includes('-webkit-background-clip:border-box'), '须复位背景裁剪：' + rule)
    assert.ok(rule.includes('-webkit-text-fill-color:currentColor'), '须复位文字填充：' + rule)
  })

  test('渲染出的章节标题确为 h3.dsh-upd-chap-title（规则落得到）', () => {
    const dom = renderUpdatePanelHTML(baseInput()).replace(/<style>[\s\S]*?<\/style>/, '')
    const hits = [...dom.matchAll(/<h3 class="dsh-upd-chap-title">/g)]
    assert.equal(hits.length, 5, '五章标题须全是挂隔离类的 h3')
  })
})
