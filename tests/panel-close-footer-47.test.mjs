/**
 * tests/panel-close-footer-47.test.mjs —— #47 定案 A：关闭住右下角独立 footer 区。
 *
 * 只测外部行为：dialog 的关闭在 05 章之后的独立 footer 内、第一章 actions 内无关闭；
 * embedded 无面板自带关闭（宿主框架自带关）；只读渲染不画；两主题 DOM 顺序一致；
 * 点 footer 关闭走同一落地（先交调用方撤 DOM，再停轮询，不停安装）。
 * 传输与容器全用假件。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel, renderUpdatePanelHTML } from '../dist/panel.js'

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

function baseQueue() {
  return { busy: false, owner: null, waiting: [], position: null }
}

function panelInput(overrides = {}) {
  return {
    snapshot: baseSnapshot(),
    manual: null,
    queue: baseQueue(),
    skippedLatest: false,
    lastError: null,
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
    mode: 'embedded',
    ...overrides,
  }
}

/** 计数容器：innerHTML 赋值可数，click/keydown 可派发（与 DOM 同口径）。 */
function countingContainer() {
  const listeners = new Map()
  let html = ''
  return {
    get innerHTML() {
      return html
    },
    set innerHTML(v) {
      html = v
    },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn))
    },
    click(attrs) {
      const target = {
        closest: (sel) => {
          if (sel !== '[data-action]') return null
          const kind = attrs['data-action'] ?? null
          if (!kind) return null
          return { getAttribute: (name) => attrs[name] ?? null }
        },
      }
      for (const fn of [...(listeners.get('click') ?? [])]) fn({ target })
    },
    keydown(event) {
      for (const fn of [...(listeners.get('keydown') ?? [])]) fn(event)
    },
  }
}

function panelCall(snapshot) {
  const log = []
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.updateStatus')) return { ok: true, snapshot, manual: null, receipt: null, queue: baseQueue() }
    if (name.endsWith('.updateCheck')) {
      return { ok: true, snapshot, manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }
    }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

function countOf(html, sub) {
  return html.split(sub).length - 1
}

/** 去 <style> 后再断言 DOM（CSS 串里也有 dsh-upd-footer 字样）。 */
function dom(h) {
  return h.replace(/<style>[\s\S]*?<\/style>/, '')
}

describe('#47 定案 A：dialog 关闭住右下角独立 footer 区', () => {
  it('dialog：footer 在 05 章之后，关闭只在 footer 内，全文恰一处', () => {
    const html = dom(renderUpdatePanelHTML(panelInput({ mode: 'dialog' })))
    assert.equal(countOf(html, 'data-action="close-view"'), 1, '关闭按钮恰一处')
    const footer = html.indexOf('dsh-upd-footer')
    assert.ok(footer !== -1, '有独立 footer 区')
    assert.ok(html.indexOf('data-action="close-view"') > footer, '关闭在 footer 内')
    assert.ok(html.indexOf('data-chapter="05"') < footer, 'footer 永远在 05 章之后')
    const aStart = html.indexOf('<div class="dsh-upd-actions">')
    assert.ok(aStart !== -1, '第一章 actions 仍在')
    const actionsHtml = html.slice(aStart, html.indexOf('</div>', aStart))
    assert.ok(!actionsHtml.includes('close-view'), '第一章 actions 内无关闭（已脱离安装更新栏）')
    assert.ok(actionsHtml.includes('data-action="copy-diag"'), '复制诊断仍在第一章，永不隐藏')
  })

  it('embedded：无面板自带关闭、无 footer（宿主框架自带关）', () => {
    const html = dom(renderUpdatePanelHTML(panelInput({ mode: 'embedded' })))
    assert.ok(!html.includes('data-action="close-view"'), '嵌入形态无关闭按钮')
    assert.ok(!html.includes('dsh-upd-footer'), '嵌入形态无 footer 区')
    assert.ok(html.includes('data-action="copy-diag"'), '复制诊断不受影响')
  })

  it('只读渲染（actions:none）：dialog 也不画关闭（动作面归调用方）', () => {
    const html = dom(renderUpdatePanelHTML(panelInput({ mode: 'dialog', actions: 'none' })))
    assert.ok(!html.includes('data-action="close-view"'), '无死按钮')
    assert.ok(!html.includes('dsh-upd-footer'), '无 footer 区')
  })

  it('两主题 DOM 顺序一致（只换肤）：去 style 后仅差 data-theme', () => {
    const strip = (h) => h.replace(/<style>[\s\S]*?<\/style>/, '')
    const a = strip(renderUpdatePanelHTML(panelInput({ mode: 'dialog' })))
    const b = strip(renderUpdatePanelHTML(panelInput({ mode: 'dialog', theme: 'archive' })))
    assert.ok(a.includes('dsh-upd-footer'), '默认主题有 footer')
    assert.ok(b.includes('dsh-upd-footer'), '档案卷有 footer')
    assert.equal(b.replace(' data-theme="archive"', ''), a, '内核 DOM 逐字同一份')
  })
})

describe('#47 定案 A：footer 关闭与旧按钮同口径', () => {
  it('点 footer 关闭：先交调用方撤 DOM，再停轮询', async () => {
    const { call, log } = panelCall(baseSnapshot())
    const box = countingContainer()
    let closed = 0
    const panel = mountUpdatePanel(box, {
      pluginId: 'p',
      prefix: 't',
      call,
      mode: 'dialog',
      pollMs: 250,
      autoChangelog: false,
      onCloseRequested: () => {
        closed += 1
        box.innerHTML = ''
      },
    })
    try {
      await panel.refresh()
      await settled()
      const mounted = dom(box.innerHTML)
      const i = mounted.indexOf('dsh-upd-footer')
      assert.ok(i !== -1 && mounted.indexOf('data-action="close-view"') > i, '挂载态关闭也在 footer 内')
      box.click({ 'data-action': 'close-view' })
      await settled()
      assert.equal(closed, 1, '落地回调被调一次（先交调用方撤 DOM）')
      const n = log.length
      await sleep(600)
      assert.equal(log.length, n, '轮询已停，不再打电话')
    } finally {
      panel.unmount()
    }
  })
})
