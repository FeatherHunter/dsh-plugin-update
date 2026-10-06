/**
 * tests/panel-scroll-fold.test.mjs —— 弹窗分栏滚动 + 更新日志折叠（#59）。
 *
 * 只测外部行为：01–05 包进同一滚动体、头尾在外固定；02 章开关只在有日志且可点时出现；
 * 默认展开、点按翻转、只读渲染恒展开；动效关键选择器存在；reduced-motion 全关。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_PANEL_CSS,
  UPDATE_PANEL_ARCHIVE_CSS,
  mountUpdatePanel,
  renderUpdatePanelHTML,
} from '../dist/panel.js'

const LOG_MD = '# Changelog\n\n## [1.1.0] - 2026-10-01\n\n### Added\n\n- 修了 A\n\n## [1.0.0] - 2026-09-01\n\n### Changed\n\n- 初始\n'

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function inputFor(overrides = {}) {
  return {
    snapshot: baseSnapshot(),
    manual: null,
    queue: { busy: false, owner: null, waiting: [], position: null },
    skippedLatest: false,
    lastError: null,
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
    mode: 'dialog',
    changelogMarkdown: LOG_MD,
    ...overrides,
  }
}

function bodyOf(html) {
  const start = html.indexOf('<div class="dsh-upd-body">')
  assert.ok(start >= 0, '应有章节滚动体')
  return html.slice(start)
}

test('滚动体：01–05 在体内有序，头尾在体外', () => {
  const html = renderUpdatePanelHTML(inputFor())
  const body = bodyOf(html)
  const order = [...body.matchAll(/data-chapter="(\d\d)"/g)].map((m) => m[1])
  assert.deepEqual(order, ['01', '02', '03', '04', '05'], '五章在体内按序')
  assert.ok(html.indexOf('<div class="dsh-upd-banner"') < html.indexOf('<div class="dsh-upd-body">'), '横幅在体外固定')
  assert.ok(html.indexOf('<div class="dsh-upd-footer"') > body.indexOf('data-chapter="05"'), '页脚在体后固定')
})

test('折叠开关：有日志才给，默认展开，标记翻转', () => {
  const open = renderUpdatePanelHTML(inputFor())
  assert.ok(open.includes('data-action="toggle-changelog"'), '有日志即给开关')
  assert.ok(open.includes('收起更新日志'), '默认文案为收起')
  assert.ok(open.includes('data-open="1"'), '默认展开')
  const shut = renderUpdatePanelHTML(inputFor({ changelogCollapsed: true }))
  assert.ok(shut.includes('展开更新日志'), '收起后文案翻转')
  assert.ok(shut.includes('data-open="0"'), '折叠标记为 0')
  assert.ok(shut.includes('修了 A'), '折叠不断内容（动画藏，非删除）')
})

test('折叠开关：中性提示与只读渲染不给开关', () => {
  const neutral = renderUpdatePanelHTML(inputFor({ snapshot: baseSnapshot({ latestVersion: null }), changelogMarkdown: null }))
  assert.ok(!neutral.includes('toggle-changelog'), '无日志不给开关')
  const readonly = renderUpdatePanelHTML(inputFor({ actions: 'none' }))
  assert.ok(!readonly.includes('toggle-changelog'), '只读渲染不给开关（无死按钮）')
  assert.ok(!readonly.includes('data-action='), '只读渲染零动作')
})

test('挂载：点按翻转即时重绘，不打电话', async () => {
  const seen = []
  const box = { innerHTML: '', addEventListener() {}, removeEventListener() {} }
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    call: async (name) => {
      seen.push(name)
      return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: { busy: false, waiting: [], position: null } }
    },
    pollMs: 60000,
    mode: 'dialog',
    autoChangelog: false,
    changelogMarkdown: LOG_MD,
  })
  try {
    await panel.refresh()
    assert.ok(box.innerHTML.includes('收起更新日志'), '挂载默认展开')
    const n = seen.length
    await panel.act('toggle-changelog')
    assert.ok(box.innerHTML.includes('展开更新日志'), '点按即收起')
    assert.ok(box.innerHTML.includes('data-open="0"'), '折叠标记同步')
    assert.equal(seen.length, n, '纯视图翻转不打电话')
    await panel.setChangelogCollapsed(false)
    assert.ok(box.innerHTML.includes('收起更新日志'), '对外方法可恢复展开')
  } finally {
    panel.unmount()
  }
})

test('动效 CSS：滚动条/磁吸头/折叠格/淡入存在，减速全关', () => {
  for (const rule of [
    '.dsh-upd-overlay .dsh-upd-body',
    'overscroll-behavior:contain',
    '.dsh-upd-chap-head{position:sticky',
    '.dsh-upd-changelog-foldbox[data-open="0"]',
    'grid-template-rows',
    '@keyframes dsh-upd-fadein',
  ]) {
    assert.ok(UPDATE_PANEL_CSS.includes(rule), '基础串须含 ' + rule)
  }
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd[data-theme="archive"] .dsh-upd-body .dsh-upd-chap-head'), 'Archive 磁吸头跟肤')
  assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-changelog-foldbox{transition:none}'), '减速下折叠静止')
})
