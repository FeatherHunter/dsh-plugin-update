/**
 * tests/dialog-close-theme-flicker.test.mjs —— 三件小事，同一根因都是“对外口径”：
 * 1. 主题首选名 archive（d5-paper 为旧别名仍可用）；2. 弹窗点关闭真能关；3. 轮询不闪（输出不变不碰 DOM）。
 * 只测外部行为，传输与容器全用假件。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel, normalizePanelTheme, renderUpdatePanelHTML } from '../dist/panel.js'
import { mountUpdateBatchPanel, renderBatchPanelHTML } from '../dist/panel-batch.js'
import { mountUpdateEntry, UPDATE_ENTRY_CSS } from '../dist/entry.js'
import { UPDATE_PANEL_D5_CSS } from '../dist/panel.js'

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

const UP_TO_DATE = baseSnapshot({ latestVersion: '1.0.0', canInstall: false })

function baseQueue() {
  return { busy: false, owner: null, waiting: [], position: null }
}

/** 计数容器：innerHTML 赋值可数，click/keydown 可派发（与 DOM 同口径）。 */
function countingContainer() {
  const listeners = new Map()
  let html = ''
  let sets = 0
  return {
    get innerHTML() {
      return html
    },
    set innerHTML(v) {
      sets += 1
      html = v
    },
    sets: () => sets,
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn))
    },
    click(attrs) {
      const target = {
        closest: (sel) => {
          if (sel !== '[data-action]' && sel !== '[data-act]') return null
          const kind = attrs['data-action'] ?? attrs['data-act'] ?? null
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

describe('主题首选名 archive，旧别名仍可用', () => {
  it('归一：archive 与 d5-paper 同一渲染，其余回 default', () => {
    assert.equal(normalizePanelTheme('archive'), 'd5-paper')
    assert.equal(normalizePanelTheme('d5-paper'), 'd5-paper')
    assert.equal(normalizePanelTheme('default'), 'default')
    assert.equal(normalizePanelTheme('nope'), 'default')
  })

  it('纯渲染：archive 与 d5-paper 输出逐字相同', () => {
    const a = renderUpdatePanelHTML(panelInput({ theme: 'archive' }))
    const b = renderUpdatePanelHTML(panelInput({ theme: 'd5-paper' }))
    assert.equal(a, b)
    assert.ok(a.includes('data-theme="d5-paper"'))
  })

  it('挂载与切换：archive 即换肤，非法仍抛错', async () => {
    const box = countingContainer()
    const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call: panelCall(UP_TO_DATE).call, pollMs: 60000, autoChangelog: false, theme: 'archive' })
    try {
      await panel.refresh()
      assert.ok(box.innerHTML.includes('data-theme="d5-paper"'), 'archive 挂载即换肤')
      await panel.setTheme('default')
      assert.ok(!box.innerHTML.includes('data-theme='))
      await panel.setTheme('archive')
      assert.ok(box.innerHTML.includes('data-theme="d5-paper"'))
      assert.throws(() => mountUpdatePanel(countingContainer(), { pluginId: 'p', call: panelCall(UP_TO_DATE).call, theme: 'nope' }), /主题非法/)
      await assert.rejects(panel.setTheme('nope'), /主题非法/)
    } finally {
      panel.unmount()
    }
  })

  it('批量纯渲染：archive 同走档案卷', () => {
    const html = renderBatchPanelHTML({ rows: [], theme: 'archive' })
    assert.ok(html.includes('data-theme="d5-paper"'))
  })
})

describe('弹窗点关闭真能关', () => {
  it('dialog + onCloseRequested：点关闭先交调用方撤 DOM，再停轮询', async () => {
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
      assert.ok(box.innerHTML.includes('data-mode="dialog"'))
      await panel.act('close-view')
      assert.equal(closed, 1, '落地回调被调一次')
      const n = log.length
      await sleep(600)
      assert.equal(log.length, n, '轮询已停，不再打电话')
    } finally {
      panel.unmount()
    }
  })

  it('dialog 无回调：保持旧行为（只停轮询，不抛错）', async () => {
    const { call, log } = panelCall(baseSnapshot())
    const box = countingContainer()
    const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, mode: 'dialog', pollMs: 60000, autoChangelog: false })
    try {
      await panel.refresh()
      const before = box.innerHTML
      await panel.act('close-view')
      assert.equal(box.innerHTML, before, '无回调即旧行为：DOM 留给调用方')
      const n = log.length
      await panel.refresh()
      assert.equal(log.length, n, '停轮询后 refresh 不再打电话')
    } finally {
      panel.unmount()
    }
  })

  it('Esc 走同一落地', async () => {
    const { call } = panelCall(baseSnapshot())
    const box = countingContainer()
    let closed = 0
    const panel = mountUpdatePanel(box, {
      pluginId: 'p',
      prefix: 't',
      call,
      mode: 'dialog',
      pollMs: 60000,
      autoChangelog: false,
      onCloseRequested: () => {
        closed += 1
      },
    })
    try {
      await panel.refresh()
      box.keydown({ key: 'Escape' })
      await settled()
      assert.equal(closed, 1)
    } finally {
      panel.unmount()
    }
  })

  it('入口件 dialog：面板点关闭即还原按钮，可重开', async () => {
    const { call } = panelCall(UP_TO_DATE)
    const box = countingContainer()
    const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000 })
    try {
      entry.open()
      await settled()
      await settled()
      assert.ok(box.innerHTML.includes('data-mode="dialog"'), 'dialog 已开')
      box.click({ 'data-action': 'close-view' })
      await settled()
      await settled()
      assert.ok(box.innerHTML.includes('dsh-upd-entry'), '按钮已还原，不再卡死')
      entry.open()
      await settled()
      assert.ok(box.innerHTML.includes('data-mode="dialog"'), '可重开')
      entry.close()
    } finally {
      entry.unmount()
    }
  })
})

describe('深色宿主下档案卷按钮可读', () => {
  it('入口件 D5 脸自己不透明，文字走变量', () => {
    assert.ok(
      UPDATE_ENTRY_CSS.includes('.dsh-upd-entry[data-theme="d5-paper"] .dsh-upd-entry-btn{border-color:var(--d5-line-strong);background:var(--d5-card);color:var(--d5-ink)'),
      '按钮脸不透明 + 文字变量化，宿主底色未知也读得出',
    )
    assert.ok(!UPDATE_ENTRY_CSS.includes('.dsh-upd-entry[data-theme="d5-paper"] .dsh-upd-entry-btn{border-color:#c4b896;background:transparent'), '旧透明脸已删')
  })

  it('入口件 D5 有深色变量覆盖（硬编码深墨只活在浅色）', () => {
    assert.ok(
      UPDATE_ENTRY_CSS.includes('@media (prefers-color-scheme: dark){.dsh-upd-entry[data-theme="d5-paper"]{--d5-ink:#ece5d3'),
      '深色下墨色变量必须翻白，否则沿用硬编码深墨即隐形',
    )
    assert.ok(!UPDATE_ENTRY_CSS.includes('data-theme="d5-paper"]{font-family:Georgia,"Songti SC","STSong","SimSun",serif;color:#1a1a1a}'), '根硬编码深墨已删')
  })

  it('面板 D5 按钮脸同样不透明', () => {
    assert.ok(
      UPDATE_PANEL_D5_CSS.includes('.dsh-upd[data-theme="d5-paper"] button{border-color:var(--d5-line-strong);background:var(--d5-card);color:var(--d5-ink)'),
    )
  })

  it('archive 别名走同一张 D5 脸（正是报障的配置）', async () => {
    const { call } = panelCall(UP_TO_DATE)
    const box = countingContainer()
    const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000, theme: 'archive' })
    try {
      await entry.refresh()
      assert.ok(box.innerHTML.includes('data-theme="d5-paper"'), '别名挂载即换肤')
      assert.ok(box.innerHTML.includes('检查更新'), '按钮文案在')
    } finally {
      entry.unmount()
    }
  })
})

describe('轮询不闪：输出不变不碰 DOM', () => {
  it('单面板：快照不变时重复 refresh 不再赋值', async () => {
    const { call } = panelCall(UP_TO_DATE)
    const box = countingContainer()
    const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000, autoChangelog: false })
    try {
      await panel.refresh()
      await settled()
      const n = box.sets()
      assert.ok(n > 0, '首绘应落盘')
      await panel.refresh()
      await panel.refresh()
      await settled()
      assert.equal(box.sets(), n, '无变化即不碰 DOM，悬停/focus 不再被打断')
    } finally {
      panel.unmount()
    }
  })

  it('批量面板：状态不变时重复 refresh 不再赋值', async () => {
    const session = { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 1, updatedAt: 1 }
    const call = async (name) => {
      if (String(name).endsWith('.batchStatus')) return { ok: true, session, rows: [], progress: null }
      throw new Error('unknown-phone:' + name)
    }
    const box = countingContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoChangelog: false })
    try {
      await panel.refresh()
      await panel.refresh()
      await settled()
      const n = box.sets()
      await panel.refresh()
      await settled()
      assert.equal(box.sets(), n)
    } finally {
      panel.unmount()
    }
  })
})
