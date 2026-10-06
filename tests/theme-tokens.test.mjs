/**
 * tests/theme-tokens.test.mjs —— 第三方主题变量覆盖（themeTokens）。
 *
 * 只测外部行为：纯序列化（空/排序/非法即抛）+ 四个挂载口（panel/panel-batch/
 * entry/entry-batch）根上写内联变量、不传零回归、挂载时非法即抛、
 * setThemeTokens 换肤可重绘、入口件打开的 dialog 同步透传。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  themeTokensStyleFor,
  renderUpdatePanelHTML,
  mountUpdatePanel,
} from '../dist/panel.js'
import { renderBatchPanelHTML, mountUpdateBatchPanel } from '../dist/panel-batch.js'
import { mountUpdateEntry } from '../dist/entry.js'
import { mountUpdateBatchEntry } from '../dist/entry-batch.js'

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

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function panelCall(snapshot) {
  return async (name) => {
    if (String(name).endsWith('.updateStatus')) {
      return { ok: true, snapshot: snapshot ?? baseSnapshot(), manual: null, receipt: null, queue: { busy: false, owner: null, waiting: [], position: null } }
    }
    return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: { busy: false, owner: null, waiting: [], position: null } }
  }
}

function batchCall() {
  return async () => ({ ok: true, session: null, rows: [], progress: null })
}

function entryCall() {
  return async () => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null })
}

describe('纯序列化 themeTokensStyleFor', () => {
  test('空/缺省回空串（不写 style，零回归）', () => {
    assert.equal(themeTokensStyleFor(undefined), '')
    assert.equal(themeTokensStyleFor(null), '')
    assert.equal(themeTokensStyleFor({}), '')
  })

  test('颜色 hex 与英文名都收，输出按词典顺序稳定', () => {
    const out = themeTokensStyleFor({ primary: '#c8402a', text: 'red', bg: '#fffdf6' })
    assert.equal(out, '--dsh-update-text:red;--dsh-update-bg:#fffdf6;--dsh-update-primary:#c8402a')
  })

  test('非颜色值走安全检查，entryScale 只收正有限数', () => {
    assert.equal(themeTokensStyleFor({ radiusPanel: '4px' }), '--dsh-update-radius-panel:4px')
    assert.equal(themeTokensStyleFor({ fontSans: 'PingFang SC, sans-serif' }), '--dsh-update-font-sans:PingFang SC, sans-serif')
    assert.equal(themeTokensStyleFor({ entryScale: 1.2 }), '--dsh-update-entry-scale:1.2')
    assert.equal(themeTokensStyleFor({ shadow: 'none' }), '--dsh-update-shadow:none')
  })

  test('非法即抛：未知键/坏颜色/注入/坏 scale/非对象', () => {
    assert.throws(() => themeTokensStyleFor({ nope: '#fff' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ primary: 'rgb(1,2,3)' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ primary: 'red;hack' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ primary: '' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ radiusPanel: '8px);hack' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ entryScale: 0 }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ entryScale: '1' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor('red'), /themeTokens/)
    assert.throws(() => themeTokensStyleFor(['--dsh-update-text:red']), /themeTokens/)
  })
})

describe('纯渲染根上写变量', () => {
  function panelInput(overrides = {}) {
    return {
      snapshot: baseSnapshot(), manual: null, queue: { busy: false, owner: null, waiting: [], position: null },
      skippedLatest: false, lastError: null, showOthers: false, pluginId: 'p', copyNotice: null,
      mode: 'embedded', ...overrides,
    }
  }

  test('单面板：传了写 style，不传无 style（零回归）', () => {
    const withTokens = renderUpdatePanelHTML(panelInput({ themeTokens: { primary: '#c8402a' } }))
    assert.ok(withTokens.includes(' style="--dsh-update-primary:#c8402a"'), '根上须有内联变量')
    const plain = renderUpdatePanelHTML(panelInput())
    assert.ok(!plain.includes(' style="--dsh-update-'), '不传不得出现变量 style')
  })

  test('单面板：dialog 与 archive 下同样写根上', () => {
    const html = renderUpdatePanelHTML(panelInput({ mode: 'dialog', theme: 'archive', themeTokens: { bg: '#fffdf6' } }))
    assert.ok(html.includes('data-theme="archive"'), '主题属性仍在')
    assert.ok(html.includes(' style="--dsh-update-bg:#fffdf6"'), '变量 style 仍在')
  })

  test('批量面板：根上写变量，不传无 style', () => {
    const withTokens = renderBatchPanelHTML({ rows: [], themeTokens: { primary: '#c8402a' } })
    assert.ok(withTokens.includes(' style="--dsh-update-primary:#c8402a"'), '批量根上须有内联变量')
    const plain = renderBatchPanelHTML({ rows: [] })
    assert.ok(!plain.includes(' style="--dsh-update-'), '不传不得出现变量 style')
  })

  test('纯渲染非法即抛', () => {
    assert.throws(() => renderUpdatePanelHTML(panelInput({ themeTokens: { nope: 1 } })), /themeTokens/)
    assert.throws(() => renderBatchPanelHTML({ rows: [], themeTokens: { primary: 'no color!!' } }), /themeTokens/)
  })
})

describe('四个挂载口', () => {
  test('单面板：挂载透传 + setThemeTokens 重绘 + 非法挂载即抛', async () => {
    const box = fakeContainer()
    const panel = mountUpdatePanel(box, { pluginId: 'p', call: panelCall(), pollMs: 60000, autoChangelog: false, themeTokens: { primary: '#c8402a' } })
    await panel.refresh()
    assert.ok(box.innerHTML.includes('--dsh-update-primary:#c8402a'), '挂载透传到根上')
    await panel.setThemeTokens({ primary: '#2563eb' })
    assert.ok(box.innerHTML.includes('--dsh-update-primary:#2563eb'), 'setThemeTokens 即时换肤')
    await panel.setThemeTokens(undefined)
    assert.ok(!box.innerHTML.includes(' style="--dsh-update-'), '传 undefined 即清掉覆盖')
    await assert.rejects(panel.setThemeTokens({ nope: 1 }), /themeTokens/)
    assert.ok(!box.innerHTML.includes('--dsh-update-nope'), '非法切换不得污染输出')
    panel.unmount()
    assert.throws(() => mountUpdatePanel(fakeContainer(), { pluginId: 'p', call: panelCall(), themeTokens: { primary: 'bad color!!' } }), /themeTokens/)
  })

  test('批量面板：挂载透传 + setThemeTokens 重绘 + 非法挂载即抛', async () => {
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 't', call: batchCall(), pollMs: 60000, themeTokens: { bg: '#fffdf6' } })
    await panel.refresh()
    assert.ok(box.innerHTML.includes('--dsh-update-bg:#fffdf6'), '批量挂载透传到根上')
    panel.setThemeTokens({ bg: '#ffffff' })
    assert.ok(box.innerHTML.includes('--dsh-update-bg:#ffffff'), 'setThemeTokens 即时换肤')
    assert.throws(() => panel.setThemeTokens({ nope: 1 }), /themeTokens/)
    panel.unmount()
    assert.throws(() => mountUpdateBatchPanel(fakeContainer(), { prefix: 't', call: batchCall(), themeTokens: 'red' }), /themeTokens/)
  })

  test('入口件：挂载透传 + setThemeTokens 重绘 + dialog 同步透传', async () => {
    const box = fakeContainer()
    const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 't', call: entryCall(), pollMs: 60000, themeTokens: { primary: '#c8402a' } })
    await entry.refresh()
    assert.ok(box.innerHTML.includes('--dsh-update-primary:#c8402a'), '入口挂载透传到根上')
    entry.setThemeTokens({ primary: '#2563eb' })
    assert.ok(box.innerHTML.includes('--dsh-update-primary:#2563eb'), 'setThemeTokens 即时换肤')
    assert.throws(() => entry.setThemeTokens({ primary: 'x'.repeat(300) }), /themeTokens/)
    entry.open()
    assert.ok(box.innerHTML.includes('--dsh-update-primary:#2563eb'), '打开的 dialog 面板同步换肤')
    entry.close()
    entry.unmount()
    assert.throws(() => mountUpdateEntry(fakeContainer(), { pluginId: 'p', prefix: 't', call: entryCall(), themeTokens: { nope: 1 } }), /themeTokens/)
  })

  test('批量入口件：挂载透传 + setThemeTokens 重绘', async () => {
    const box = fakeContainer()
    const entry = mountUpdateBatchEntry(box, { prefix: 't', call: batchCall(), pollMs: 60000, themeTokens: { primary: '#c8402a' } })
    await entry.refresh()
    assert.ok(box.innerHTML.includes('--dsh-update-primary:#c8402a'), '批量入口挂载透传到根上')
    entry.setThemeTokens(undefined)
    assert.ok(!box.innerHTML.includes(' style="--dsh-update-'), '传 undefined 即清掉覆盖')
    assert.throws(() => entry.setThemeTokens({ primary: 'red;blue' }), /themeTokens/)
    entry.unmount()
  })
})
