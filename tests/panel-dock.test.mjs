/**
 * tests/panel-dock.test.mjs —— T5 常驻更新进度 dock 验收。
 *
 * 两层分别验收：
 *   1. hubDockViewModel：纯数据口径（可见性、单/多会话文本与百分比、坏输入不抛）；
 *   2. mountHubProgressDock：DOM 骨架（只 append 一个根节点、样式只注入一次）、轮询口径、
 *      document.hidden 暂停、dispose 清理、坏回包保持上一次画面。
 *
 * DOM 用最小 stub（不引 jsdom）：组件只用到 createElement/appendChild/removeChild/textContent/
 * className/style.width/addEventListener/dispatch，stub 只实现这些；定时器用可注入的假表，
 * 不靠 sleep 等真实时间。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { HUB_DOCK_POLL, hubDockViewModel, mountHubProgressDock } from '../dist/panel/batch/dock.js'

// ---------- 最小 DOM stub ----------

class FakeElement {
  constructor(tag) {
    this.tagName = tag
    this.className = ''
    this.textContent = ''
    this.style = {}
    this.children = []
    this.attributes = {}
    this.listeners = new Map()
    this.parentNode = null
  }

  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null
  }

  /** 递归拼出子树文本（stub 没有真实 DOM 的 textContent 聚合语义）。 */
  get text() {
    return [this.textContent, ...this.children.map((child) => child.text)].join(' ')
  }

  appendChild(node) {
    this.children.push(node)
    node.parentNode = this
    return node
  }

  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index >= 0) this.children.splice(index, 1)
    node.parentNode = null
    return node
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((item) => item !== listener),
    )
  }

  dispatch(type, event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event ?? { type, target: this })
    }
  }

  click() {
    this.dispatch('click')
  }
}

class FakeDocument {
  constructor() {
    this.hidden = false
    this.head = new FakeElement('head')
    this.listeners = new Map()
  }

  createElement(tag) {
    const element = new FakeElement(tag)
    element.ownerDocument = this
    return element
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((item) => item !== listener),
    )
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this })
  }

  /** 模拟切前后台：改 hidden 再派发 visibilitychange。 */
  setHidden(hidden) {
    this.hidden = hidden
    this.dispatch('visibilitychange')
  }
}

function fakeMountTarget() {
  const doc = new FakeDocument()
  const container = new FakeElement('div')
  container.ownerDocument = doc
  return { doc, container }
}

// ---------- 快照夹具（形状对齐 core/hub/snapshot.ts） ----------

function progressOf(overrides = {}) {
  return { total: 4, done: 2, failed: 0, skipped: 0, current: 1, pending: 1, finished: false, ...overrides }
}

function sessionOf(overrides = {}) {
  const progress = overrides.progress ?? progressOf()
  return {
    sessionId: 's1',
    owner: 'life',
    selfKey: null,
    state: 'running',
    updatedAt: 1000,
    progress,
    rows: [],
    rowsTotal: 0,
    rowsTruncated: false,
    ...overrides,
  }
}

function snapshotOf(overrides = {}) {
  const sessions = overrides.sessions ?? []
  return {
    version: 1,
    at: 1000,
    sessions,
    sessionsTotal: overrides.sessionsTotal ?? sessions.length,
    sessionsTruncated: false,
    activeInstall: overrides.activeInstall ?? null,
  }
}

// ---------- 假定时器：记录延迟、可触发、可清理 ----------

function withFakeTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending = new Map()
  let nextId = 1

  globalThis.setTimeout = (callback, delay) => {
    const handle = { id: nextId++, unref() {} }
    pending.set(handle, { callback, delay })
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    pending.delete(handle)
  }

  return {
    pending,
    delays() {
      return [...pending.values()].map((entry) => entry.delay)
    },
    /** 用真实定时器让出一拍，把组件内部 await 出来的微任务全部跑完。 */
    flush() {
      return new Promise((resolve) => realSetTimeout(resolve, 0))
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

// ---------- 视图模型 ----------

describe('hubDockViewModel（纯视图模型）', () => {
  it('坏输入不抛：null/字符串/数组/缺字段一律当空', () => {
    for (const bad of [null, undefined, '', 'snapshot', 42, [], {}, { sessions: 'nope' }]) {
      const view = hubDockViewModel(bad)
      assert.equal(view.visible, false)
      assert.deepEqual(view.sessions, [])
      assert.equal(view.percent, 0)
      assert.equal(view.text, '')
    }
  })

  it('空快照：不可见（空闲隐藏、不占空间）', () => {
    const view = hubDockViewModel(snapshotOf())
    assert.equal(view.visible, false)
    assert.equal(view.activeSessions, 0)
    assert.equal(view.percent, 0)
  })

  it('单会话：文本、百分比与失败档位', () => {
    const view = hubDockViewModel(
      snapshotOf({
        sessions: [
          sessionOf({
            progress: progressOf({ total: 4, done: 2, failed: 1, skipped: 0, current: 1, pending: 0 }),
          }),
        ],
      }),
    )
    assert.equal(view.visible, true)
    assert.equal(view.activeSessions, 1)
    assert.equal(view.sessions.length, 1)
    // 终态 = done + failed + skipped = 3 / 4 → 75%
    assert.equal(view.percent, 75)
    assert.equal(view.sessions[0].percent, 75)
    assert.match(view.sessions[0].text, /life/)
    assert.match(view.sessions[0].text, /75%/)
    assert.match(view.sessions[0].text, /3\/4/)
    assert.equal(view.tone, 'warn')
    assert.equal(view.failed, 1)
    assert.ok(view.failureText.length > 0)
    assert.equal(view.text, '75%')
  })

  it('多会话：聚合百分比按行数加权，一行一个会话文本', () => {
    const view = hubDockViewModel(
      snapshotOf({
        sessions: [
          sessionOf({ sessionId: 's1', owner: 'life', progress: progressOf({ total: 4, done: 3, current: 1, pending: 0 }) }),
          sessionOf({ sessionId: 's2', owner: 'tool', progress: progressOf({ total: 2, done: 0, current: 0, pending: 2 }) }),
        ],
      }),
    )
    assert.equal(view.visible, true)
    assert.equal(view.activeSessions, 2)
    assert.equal(view.sessionsTotal, 2)
    assert.equal(view.percent, 50) // 3 个终态 / 6 行
    assert.equal(view.sessions.length, 2)
    assert.match(view.sessions[0].text, /life/)
    assert.match(view.sessions[0].text, /75%/)
    assert.match(view.sessions[1].text, /tool/)
    assert.match(view.sessions[1].text, /0%/)
    assert.ok(view.statusText.includes('2'), '多会话状态语句要带会话数')
  })

  it('activeInstall 单独存在也能可见（并跟随语言）', () => {
    const snapshot = snapshotOf({ sessions: [], activeInstall: { pluginId: 'life', startedAt: 123 } })
    const zh = hubDockViewModel(snapshot, { lang: 'zh' })
    assert.equal(zh.visible, true)
    assert.equal(zh.activeInstall.pluginId, 'life')
    assert.equal(zh.tone, 'busy')
    assert.equal(zh.statusText, '正在安装…')

    const en = hubDockViewModel(snapshot, { lang: 'en' })
    assert.equal(en.statusText, 'Installing…')
  })

  it('finished / missing 会话不参与聚合也不占空间', () => {
    const view = hubDockViewModel(
      snapshotOf({
        sessions: [
          sessionOf({ sessionId: 's1', state: 'finished' }),
          sessionOf({ sessionId: 's2', state: 'missing' }),
          sessionOf({ sessionId: 's3', state: 'weird' }),
        ],
      }),
    )
    assert.equal(view.visible, false)
    assert.equal(view.activeSessions, 0)
  })

  it('缺 progress 时按 rows 的 phase 兜底；坏计数不越界', () => {
    const view = hubDockViewModel(
      snapshotOf({
        sessions: [
          {
            sessionId: 's1',
            owner: 'life',
            state: 'running',
            rows: [{ phase: 'done' }, { phase: 'failed' }, { phase: 'installing' }, { phase: 'pending' }],
          },
          sessionOf({ sessionId: 's2', progress: progressOf({ total: 2, done: 9, failed: -3, skipped: 'x' }) }),
        ],
      }),
    )
    assert.equal(view.visible, true)
    assert.equal(view.sessions[0].total, 4)
    assert.equal(view.sessions[0].done, 1)
    assert.equal(view.sessions[0].failed, 1)
    assert.equal(view.sessions[0].current, 1)
    assert.equal(view.sessions[0].percent, 50)
    // 坏计数（done 超过 total）只夹到 100%，不画越界宽度。
    assert.equal(view.sessions[1].percent, 100)
    // 聚合口径用夹紧后的计数：(2 终态 + 9 终态) / (4 + 2) 超过 total → 同样夹到 100%。
    assert.equal(view.percent, 100)
  })
})

// ---------- 挂载与生命周期 ----------

describe('mountHubProgressDock（挂载与生命周期）', () => {
  it('挂载：只 append 一个自管根节点，按前缀打 updateHubStatus 电话', async () => {
    const { doc, container } = fakeMountTarget()
    const calls = []
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      call: async (name, args) => {
        calls.push([name, args])
        return { ok: true, snapshot: snapshotOf({ sessions: [sessionOf()] }) }
      },
    })
    try {
      await dock.update()
      assert.equal(calls.length >= 1, true)
      assert.equal(calls[0][0], 'wf.updateHubStatus')
      assert.deepEqual(calls[0][1], {})

      assert.equal(container.children.length, 1, '容器里只能有 dock 自己的根节点')
      const root = container.children[0]
      assert.match(root.className, /dsh-hub-dock/)
      assert.match(root.className, /dsh-hub-dock-mode-bottom-right/)
      assert.doesNotMatch(root.className, /dsh-hub-dock-idle/)
      assert.match(root.text, /life/)
      assert.match(root.text, /50%/) // 默认夹具：total 4，终态 done 2 + failed 0 + skipped 0 = 2/4
      assert.match(root.text, /2\/4/)
      assert.equal(doc.head.children.filter((child) => child.tagName === 'style').length, 1, '样式只注入一次')
    } finally {
      dock.dispose()
    }
  })

  it('样式只注入一次：同一 document 上的第二个 dock 复用同一份', () => {
    const { doc, container } = fakeMountTarget()
    const options = { prefix: 'wf', call: async () => ({ ok: true, snapshot: snapshotOf() }) }
    const first = mountHubProgressDock(container, options)
    const other = new FakeElement('div')
    other.ownerDocument = doc
    const second = mountHubProgressDock(other, options)
    try {
      assert.equal(doc.head.children.filter((child) => child.tagName === 'style').length, 1)
      assert.equal(other.children.length, 1)
      assert.equal(second.update instanceof Function, true)
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  it('空闲隐藏：空快照 → idle 类；dispose 摘走根节点', async () => {
    const { container } = fakeMountTarget()
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      call: async () => ({ ok: true, snapshot: snapshotOf() }),
    })
    await dock.update()
    const root = container.children[0]
    assert.match(root.className, /dsh-hub-dock-idle/)
    dock.dispose()
    assert.equal(container.children.length, 0)
    dock.dispose() // 幂等
  })

  it('点击标题区触发 onOpen；回调抛错不连坐 dock', async () => {
    const { container } = fakeMountTarget()
    let opened = 0
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      call: async () => ({ ok: true, snapshot: snapshotOf({ sessions: [sessionOf()] }) }),
      onOpen: () => {
        opened += 1
        throw new Error('integrator callback failed')
      },
    })
    try {
      await dock.update()
      const head = container.children[0].children[0]
      head.click()
      assert.equal(opened, 1)
      head.click()
      assert.equal(opened, 2)
    } finally {
      dock.dispose()
    }
  })

  it('坏回包不抛：ok:false / 传输抛错 / 垃圾形状都保持上一次画面', async () => {
    const { doc, container } = fakeMountTarget()
    // 隐藏挂载：本用例只验收坏回包容错，不让后台初始 tick 与手动 update 抢同一拍。
    doc.hidden = true
    const replies = [
      async () => ({ ok: false, error: 'busy' }),
      async () => {
        throw new Error('transport down')
      },
      async () => 'garbage',
      async () => ({ ok: true, snapshot: null }),
      async () => ({ ok: true, snapshot: snapshotOf({ sessions: [sessionOf()] }) }),
    ]
    let index = 0
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      call: async () => replies[Math.min(index++, replies.length - 1)](),
    })
    try {
      await dock.update()
      const root = container.children[0]
      assert.match(root.className, /dsh-hub-dock-idle/, '第一拍失败应保持空闲')

      // 一拍好数据：画出来；随后再坏，也不许把已画的画面清掉。
      index = replies.length - 1
      await dock.update()
      assert.doesNotMatch(root.className, /dsh-hub-dock-idle/)
      const goodText = root.text
      assert.match(goodText, /life/)
      for (let i = 0; i < 4; i += 1) {
        index = i
        await dock.update()
        assert.match(root.text, /life/, '坏回包不许清空上一次画面')
      }
    } finally {
      dock.dispose()
    }
  })

  it('轮询：默认 1 秒、最小 250 毫秒；dispose 后停表且不再打电话', async () => {
    const timers = withFakeTimers()
    try {
      const { container } = fakeMountTarget()
      let calls = 0
      const dock = mountHubProgressDock(container, {
        prefix: 'wf',
        call: async () => {
          calls += 1
          return { ok: true, snapshot: snapshotOf({ sessions: [sessionOf()] }) }
        },
      })
      try {
        await timers.flush()
        assert.equal(calls, 1, '挂载后先拉一拍')
        assert.deepEqual(timers.delays(), [HUB_DOCK_POLL.defaultMs])
        assert.equal(HUB_DOCK_POLL.defaultMs, 1000)
        assert.equal(HUB_DOCK_POLL.minMs, 250)

        dock.dispose()
        assert.equal(timers.pending.size, 0, 'dispose 必须清掉在等的那一拍')
        const callsBefore = calls
        await dock.update() // dispose 后的手动刷新也应短路
        await timers.flush()
        assert.equal(calls, callsBefore, 'dispose 后不许再打电话')
        assert.equal(timers.pending.size, 0)
      } finally {
        dock.dispose()
      }

      // 显式 pollMs：250 可收；10 越界报错（挂载期错误，不静默降级）。
      const target = fakeMountTarget()
      const fast = mountHubProgressDock(target.container, {
        prefix: 'wf',
        pollMs: HUB_DOCK_POLL.minMs,
        call: async () => ({ ok: true, snapshot: snapshotOf() }),
      })
      await timers.flush()
      assert.deepEqual(timers.delays(), [HUB_DOCK_POLL.minMs])
      fast.dispose()
      assert.throws(() => mountHubProgressDock(target.container, { prefix: 'wf', pollMs: 10, call: async () => ({}) }))
      assert.throws(() => mountHubProgressDock(target.container, { prefix: 'wf', pollMs: 'fast', call: async () => ({}) }))
    } finally {
      timers.restore()
    }
  })

  it('document.hidden：隐藏时暂停轮询，恢复可见后立即刷新并续上', async () => {
    const timers = withFakeTimers()
    try {
      const { doc, container } = fakeMountTarget()
      doc.hidden = true
      let calls = 0
      const dock = mountHubProgressDock(container, {
        prefix: 'wf',
        call: async () => {
          calls += 1
          return { ok: true, snapshot: snapshotOf({ sessions: [sessionOf()] }) }
        },
      })
      try {
        await timers.flush()
        assert.equal(calls, 0, '隐藏时挂载不拉数据也不排表')
        assert.equal(timers.pending.size, 0)

        doc.setHidden(false)
        await timers.flush()
        assert.equal(calls, 1, '恢复可见立即刷新一次')
        assert.equal(timers.pending.size, 1, '并续上轮询')

        doc.setHidden(true)
        assert.equal(timers.pending.size, 0, '再隐藏要清掉在等的那一拍')
      } finally {
        dock.dispose()
      }
    } finally {
      timers.restore()
    }
  })

  it('配置错误在挂载期抛出：缺 call / 缺 prefix+phone / 坏容器 / 坏 mountAs / 坏前缀', () => {
    const { container } = fakeMountTarget()
    const call = async () => ({ ok: true, snapshot: snapshotOf() })
    assert.throws(() => mountHubProgressDock(container, {}))
    assert.throws(() => mountHubProgressDock(container, { prefix: 'wf' }))
    assert.throws(() => mountHubProgressDock(container, { call }))
    assert.throws(() => mountHubProgressDock({}, { prefix: 'wf', call }))
    assert.throws(() => mountHubProgressDock(container, { prefix: 'wf', mountAs: 'top-left', call }))
    assert.throws(() => mountHubProgressDock(container, { prefix: 'bad.prefix', call }))

    // 显式 phone 优先于 prefix；mountAs 落到类名上。
    const bar = mountHubProgressDock(container, { phone: 'custom.updateHubStatus', mountAs: 'bottom-bar', call })
    try {
      assert.equal(container.children.length, 1)
      assert.match(container.children[0].className, /dsh-hub-dock-mode-bottom-bar/)
    } finally {
      bar.dispose()
    }
  })
})

// ---------- #251 验收补齐：位置 / 行级明细 / 待重启 / 折叠 / 上限 / refresh ----------

function rowOf(overrides = {}) {
  return {
    key: 'a',
    title: 'life',
    phase: 'installing',
    targetVersion: '0.3.85',
    installedVersion: '0.3.83',
    latestVersion: '0.3.85',
    restartRequired: false,
    error: null,
    ...overrides,
  }
}

function snapshotWithRows(rows, progressOverrides = {}) {
  return snapshotOf({
    sessions: [
      sessionOf({
        progress: progressOf({ total: rows.length, done: 0, current: 1, pending: rows.length - 1, ...progressOverrides }),
        rows,
        rowsTotal: rows.length,
      }),
    ],
  })
}

describe('T5 验收补齐（#251）', () => {
  it('行级明细：标题 / 版本箭头 / 相位人话 / 失败码都画;空文本不 append 空 span', () => {
    const { container } = fakeMountTarget()
    const rows = [
      rowOf({ key: 'a', title: 'life', phase: 'installing' }),
      rowOf({ key: 'b', title: 'bill', phase: 'failed', targetVersion: null, installedVersion: null, error: 'install-failed' }),
    ]
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      call: async () => ({ ok: true, snapshot: snapshotWithRows(rows) }),
    })
    return (async () => {
      try {
        await dock.update()
        const root = container.children[0]
        const rowList = root.children.find((child) => child.className === 'dsh-hub-dock-rows')
        assert.ok(rowList, '要有行级明细容器')
        assert.equal(rowList.children.length, 2)
        const first = rowList.children[0]
        assert.match(first.text, /life/)
        assert.match(first.text, /0\.3\.83 -> 0\.3\.85/)
        assert.match(first.text, /安装中|正在安装/)
        const second = rowList.children[1]
        assert.equal(second.className.includes('dsh-hub-dock-row-failed'), true)
        assert.match(second.text, /install-failed/)
        // 没有失败码的行不挂失败样式,也不追加空 span（标题/版本/相位 3 个）。
        assert.equal(first.children.length, 3)
        assert.equal(second.children.length, 4)
      } finally {
        dock.dispose()
      }
    })()
  })

  it('待重启汇总：会话 restartCount 与聚合 restartCount 一致，文案进摘要', () => {
    const { container } = fakeMountTarget()
    const rows = [rowOf({ key: 'a', restartRequired: true, phase: 'done' }), rowOf({ key: 'b', title: 'bill', restartRequired: true, phase: 'done' })]
    const view = hubDockViewModel(snapshotWithRows(rows), { lang: 'zh' })
    assert.equal(view.restartCount, 2)
    assert.ok(view.restartText.length > 0)
    assert.ok(view.summaryText.includes(view.restartText))
    assert.equal(view.failed, 0)

    const dock = mountHubProgressDock(container, { prefix: 'wf', call: async () => ({ ok: true, snapshot: snapshotWithRows(rows) }) })
    return (async () => {
      try {
        await dock.update()
        const meta = container.children[0].children.find((child) => child.className === 'dsh-hub-dock-meta')
        assert.ok(meta.text.length > 0)
      } finally {
        dock.dispose()
      }
    })()
  })

  it('行数上限：maxRows 只画前 N 行,其余折叠成 +K 计数', async () => {
    const { container } = fakeMountTarget()
    const rows = [0, 1, 2, 3, 4].map((index) => rowOf({ key: 'k' + index, title: 't' + index }))
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      maxRows: 2,
      call: async () => ({ ok: true, snapshot: snapshotWithRows(rows) }),
    })
    try {
      await dock.update()
      const root = container.children[0]
      const rowList = root.children.find((child) => child.className === 'dsh-hub-dock-rows')
      assert.equal(rowList.children.length, 2)
      const folded = root.children.find((child) => child.className === 'dsh-hub-dock-folded')
      assert.equal(folded.textContent, '+3')
    } finally {
      dock.dispose()
    }
  })

  it('折叠：collapsed 初始只留一行计数,点 toggle 展开再折回', async () => {
    const { container } = fakeMountTarget()
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      collapsed: true,
      call: async () => ({ ok: true, snapshot: snapshotWithRows([rowOf()]) }),
    })
    try {
      await dock.update()
      const root = container.children[0]
      assert.match(root.className, /dsh-hub-dock-collapsed/)
      const toggle = root.children.find((child) => child.className === 'dsh-hub-dock-toggle')
      assert.equal(toggle.getAttribute('aria-expanded'), 'false')
      toggle.click()
      assert.doesNotMatch(root.className, /dsh-hub-dock-collapsed/)
      assert.equal(toggle.getAttribute('aria-expanded'), 'true')
      toggle.click()
      assert.match(root.className, /dsh-hub-dock-collapsed/)
    } finally {
      dock.dispose()
    }
  })

  it('hideWhenIdle:false 时空壳保留（不挂 idle 类）,inline 形态落到类名', async () => {
    const { container } = fakeMountTarget()
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      mountAs: 'inline',
      hideWhenIdle: false,
      call: async () => ({ ok: true, snapshot: snapshotOf() }),
    })
    try {
      await dock.update()
      const root = container.children[0]
      assert.match(root.className, /dsh-hub-dock-mode-inline/)
      assert.doesNotMatch(root.className, /dsh-hub-dock-idle/)
      assert.match(root.className, /dsh-hub-dock-empty/)
    } finally {
      dock.dispose()
    }
  })

  it('refresh 是 update 的同义名：调一次就重拉一次,且失败回包不清空上次画面', async () => {
    const { doc, container } = fakeMountTarget()
    doc.hidden = true // 关掉挂载自动那一拍，让计数只反映手动 refresh

    let calls = 0
    let broken = false
    const dock = mountHubProgressDock(container, {
      prefix: 'wf',
      call: async () => {
        calls += 1
        return broken ? { ok: false } : { ok: true, snapshot: snapshotWithRows([rowOf()]) }
      },
    })
    try {
      await dock.refresh()
      assert.equal(calls, 1)
      const root = container.children[0]
      assert.match(root.text, /life/)
      broken = true
      await dock.refresh()
      assert.equal(calls, 2)
      assert.match(root.text, /life/, '坏回包保持上一次画面')
    } finally {
      dock.dispose()
    }
  })
})
