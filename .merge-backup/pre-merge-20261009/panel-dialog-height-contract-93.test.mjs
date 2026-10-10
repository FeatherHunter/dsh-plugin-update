/**
 * tests/panel-dialog-height-contract-93.test.mjs —— 弹窗高度让渡契约（#93）。
 *
 * 只测外部行为（本仓风格：断 CSS 串，不做像素比对）：真实布局由 scripts/panel-layout-probe.mjs
 * 量盒子（可选仪器，有 Chrome 才跑）；这里守的是"契约本身还在不在"，正是会复发的那两处：
 *   1. 弹窗帧：只有滚动区让高度，其余各区不吃收缩（不再出现"谁写了 min-height 谁被压"）；
 *   2. 章节区有下限、面板自身可在外层滚（矮窗下页脚仍可滚达）；
 *   3. 档案卷横幅不再声明布局语义（flex-wrap / flex-direction / display）——皮肤只换肤；
 *   4. 契约为弹窗作用域：embedded 与批量面板（无滚动区）零影响；
 *   5. 内核 DOM 顺序与文案键不动。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UPDATE_PANEL_CSS, UPDATE_PANEL_ARCHIVE_CSS, renderUpdatePanelHTML } from '../dist/panel.js'

/** 契约三行（与 src/panel.ts 同一个字符串；形状改了这里就该红）。 */
const FRAME_RULE = '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body)>:not(.dsh-upd-body){flex:none}'
const SCROLL_RULE = '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body){overflow-x:hidden;overflow-y:auto}'
const FLOOR_RULE = '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body)>.dsh-upd-body{min-height:8em}'

/** 取 CSS 串里**所有**以该选择器开头的规则（同名规则可能有多条：调色一条、皮肤一条）。 */
function rulesWith(css, selector) {
  const out = []
  let at = css.indexOf(selector + '{')
  while (at >= 0) {
    const end = css.indexOf('}', at)
    if (end < 0) break
    out.push(css.slice(at, end + 1))
    at = css.indexOf(selector + '{', end)
  }
  return out
}

function baseInput(overrides = {}) {
  return {
    snapshot: {
      runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0',
      canInstall: false, blockedReason: null,
      job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' },
    },
    manual: null, queue: null, skippedLatest: false, lastError: null,
    mode: 'dialog', showOthers: false, pluginId: 'p', copyNotice: null, profileName: 'desktop',
    ...overrides,
  }
}

describe('#93 弹窗高度让渡契约', () => {
  test('只有滚动区让高度：帧契约 + 滚动区下限 + 面板外层可滚', () => {
    assert.ok(UPDATE_PANEL_CSS.includes(FRAME_RULE), '弹窗帧须声明"非滚动区不吃收缩"')
    assert.ok(UPDATE_PANEL_CSS.includes(SCROLL_RULE), '弹窗面板须把纵向溢出交给自身滚动（横向仍 hidden）')
    assert.ok(UPDATE_PANEL_CSS.includes(FLOOR_RULE), '章节区须有下限，别塌成 0')
  })

  test('契约是弹窗作用域：三段都挂在 .dsh-upd-overlay 下，embedded 与批量面板不被波及', () => {
    for (const rule of [FRAME_RULE, SCROLL_RULE, FLOOR_RULE]) {
      assert.ok(rule.startsWith('.dsh-upd-overlay '), rule + ' 必须以 .dsh-upd-overlay 起头')
      assert.ok(rule.includes(':has(>.dsh-upd-body)'), rule + ' 必须只认"带滚动区的弹窗帧"（批量面板没有滚动区，不吃本契约）')
    }
    assert.ok(
      UPDATE_PANEL_CSS.includes('.dsh-upd-overlay .dsh-upd{background:var(--dsh-update-bg,#ffffff);max-height:85vh;display:flex;flex-direction:column;overflow:hidden}'),
      '没带滚动区的弹窗帧（批量面板就是这种）必须原样：overflow 仍 hidden，不吃本契约',
    )
  })

  test('内核仍拥有横幅布局：纵向排列 + 滚动区 flex:1 1 auto', () => {
    assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-banner{min-height:3.4em;display:flex;flex-direction:column;justify-content:center}'),
      '横幅的纵向排列归内核，不许挪进皮肤')
    assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-overlay .dsh-upd-body{flex:1 1 auto'), '滚动区仍是唯一让高度的区')
  })

  test('档案卷横幅只换肤：不带 flex-wrap / flex-direction / display', () => {
    const rules = rulesWith(UPDATE_PANEL_ARCHIVE_CSS, '.dsh-upd[data-theme="archive"] .dsh-upd-banner')
    assert.ok(rules.length > 0, '档案卷横幅规则必须还在（只清布局声明，不删皮肤）')
    for (const rule of rules) {
      for (const banned of ['flex-wrap', 'flex-direction', 'display']) {
        assert.ok(!rule.includes(banned), '档案卷横幅不得声明 ' + banned + '（皮肤只换颜色/字体/间距）：' + rule)
      }
    }
    const joined = rules.join('\n')
    for (const kept of ['border', 'padding', 'font-size', 'font-family', 'gap', 'align-items']) {
      assert.ok(joined.includes(kept), '档案卷横幅的皮肤属性 ' + kept + ' 不该被误删')
    }
  })

  test('档案卷其余横幅规则（按档位）不受影响', () => {
    assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"]'),
      '忙碌档配色仍在')
    assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child'),
      '待重启档的标记布局（子元素级）不动')
  })

  test('行为不变：内核 DOM 顺序与双主题同一份', () => {
    const html = renderUpdatePanelHTML(baseInput(), 'zh')
    const cut = (h) => h.replace(/<style>[\s\S]*?<\/style>/, '')
    const dom = cut(html)
    assert.ok(dom.indexOf('<div class="dsh-upd-banner"') < dom.indexOf('<div class="dsh-upd-body">'), '横幅仍在章节区之前')
    assert.ok(dom.indexOf('<div class="dsh-upd-body">') < dom.indexOf('dsh-upd-footer'), '页脚仍在章节区之后')
    const archive = cut(renderUpdatePanelHTML(baseInput({ theme: 'archive' }), 'zh'))
    assert.equal(archive.slice(archive.indexOf('<div class="dsh-upd-banner"')), dom.slice(dom.indexOf('<div class="dsh-upd-banner"')),
      '双主题内核逐字同一份（从横幅起）')
  })

  test('embedded 输出与旧版一致：不带 overlay 类', () => {
    const embedded = renderUpdatePanelHTML(baseInput({ mode: 'embedded' }), 'zh')
    const dom = embedded.replace(/<style>[\s\S]*?<\/style>/, '')
    assert.ok(!dom.includes('dsh-upd-overlay'), 'embedded 不该出现 overlay 包裹')
    assert.ok(dom.trimStart().startsWith('<div class="dsh-upd"'), 'embedded 根就是面板本身')
  })
})