/**
 * tests/panel-err-wrap-199.test.mjs —— 04 错误信息长行不断被右框硬裁（#199）。
 *
 * 现场：单插件面板 04「错误信息」区的日志指引行是「中文散文 + 多段行内命令/标识混排」
 * 的长行，到达面板可用宽度后不换行，被右边框硬裁（无省略号、无横向滚动提示）。
 * 根因：日志/错误行容器只声明边距字号、没有任何换行契约，而纵滚区横向裁断，
 * 同类长内容列（版本号行、批量状态列、安装按钮状态行）早有不断行不溢出的先例。
 *
 * 只测外部行为：渲染 HTML 里 04 行存在 + 样式里有换行契约（双主题同源）+ 纵滚区
 * 横向策略仍是裁断（防回退到横向滚动）。不量像素、不碰真机。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UPDATE_PANEL_CSS, renderUpdatePanelHTML } from '../dist/panel.js'

function baseInput(overrides = {}) {
  return {
    snapshot: {
      runningVersion: '2.1.2', installedVersion: '2.1.2', latestVersion: '2.1.2',
      canInstall: false, blockedReason: null, job: null,
    },
    manual: null,
    queue: { busy: false, owner: null, waiting: [], position: null },
    skippedLatest: false,
    lastError: null,
    showOthers: false,
    pluginId: 'dsh-opencode-palette',
    copyNotice: null,
    mode: 'dialog',
    ...overrides,
  }
}

function styleOf(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/)
  return m ? m[1] : ''
}

describe('04 长行换行（#199）：日志/错误行不断行不溢出', () => {
  test('内核给日志行与错误行换行契约', () => {
    assert.ok(
      /\.dsh-upd-log[^{]*\{[^}]*overflow-wrap:anywhere/.test(UPDATE_PANEL_CSS),
      '日志行容器须有不断行不溢出的换行契约',
    )
    assert.ok(
      /\.dsh-upd-err[^{]*\{[^}]*overflow-wrap:anywhere/.test(UPDATE_PANEL_CSS),
      '错误行容器须有不断行不溢出的换行契约',
    )
  })

  test('双主题渲染出的 04 行都落在换行契约下（内核一次覆盖）', () => {
    for (const theme of ['default', 'archive']) {
      const html = renderUpdatePanelHTML({ ...baseInput(), theme })
      assert.ok(html.includes('class="dsh-upd-log"'), `${theme}：04 日志行须存在`)
      assert.ok(
        styleOf(html).includes('overflow-wrap:anywhere'),
        `${theme}：随包样式须带换行契约`,
      )
    }
  })

  test('纵滚区横向仍裁断：不回退到横向滚动条', () => {
    assert.ok(
      UPDATE_PANEL_CSS.includes(
        '.dsh-upd-overlay .dsh-upd-body{flex:1 1 auto;overflow-x:hidden;overflow-y:auto',
      ),
      '纵滚区横向策略须保持裁断（只让 04 行先折行，不开横向滚动）',
    )
  })
})
