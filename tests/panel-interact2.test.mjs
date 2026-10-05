// tests/panel-interact2.test.mjs —— #37 第二批：spinner/title/toast过期/骨架/取消确认/Esc。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const tick = () => new Promise((r) => setTimeout(r, 10))

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn))
    },
    click(attrs) {
      const target = {
        closest: (sel) => {
          const m = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel)
          if (!m || !Object.prototype.hasOwnProperty.call(attrs, m[1])) return null
          if (m[2] !== undefined && attrs[m[1]] !== m[2]) return null
          return { getAttribute: (name) => attrs[name] ?? null }
        },
      }
      for (const fn of [...(listeners.get('click') ?? [])]) fn({ target })
    },
    key(key) {
      for (const fn of [...(listeners.get('keydown') ?? [])]) fn({ key })
    },
  }
}

test('单面板：首帧 loading 有骨架占位', async () => {
  const { mountUpdatePanel } = await import('../dist/panel.js')
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    prefix: 't',
    call: () => new Promise(() => {}),
    pollMs: 60000,
  })
  await tick()
  assert.ok(box.innerHTML.includes('正在读取更新状态…'), 'loading 横幅仍在')
  assert.ok(box.innerHTML.includes('dsh-upd-skv'), '骨架占位在')
  assert.ok(box.innerHTML.includes('aria-hidden="true"'), '骨架不进语义')
  panel.unmount()
})

test('单面板：复制回执 5 秒后过期（toast 语义）', async () => {
  const { mountUpdatePanel } = await import('../dist/panel.js')
  const box = fakeContainer()
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const panel = mountUpdatePanel(box, {
      pluginId: 'p',
      prefix: 't',
      call: async () => ({
        ok: true,
        snapshot: { runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: null, canInstall: false },
        manual: 'dsh plugin --profile x add foo@1.0.0',
      }),
      pollMs: 60000,
    })
    await tick()
    await tick()
    box.click({ 'data-action': 'copy-manual' })
    await tick()
    assert.ok(box.innerHTML.includes('手工命令已复制'), '复制回执当即出现')
    box.click({ 'data-action': 'copy-manual' })
    await tick()
    assert.ok(box.innerHTML.includes('手工命令已复制'), '再次点击是新的 5 秒，不沿用旧戳')
    now += 6000
    await panel.refresh() // 下一次重绘触发过期检查
    await tick()
    assert.ok(!box.innerHTML.includes('手工命令已复制'), '过期后消失')
    panel.unmount()
  } finally {
    Date.now = realNow
  }
})

test('单面板：动作按钮带原生 title', async () => {
  const { mountUpdatePanel } = await import('../dist/panel.js')
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    prefix: 't',
    call: async () => ({
      ok: true,
      snapshot: { runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.0.1', canInstall: true },
      manual: 'cmd',
    }),
    pollMs: 60000,
  })
  await tick()
  await tick()
  assert.ok(box.innerHTML.includes('title="重新向官方源查一次新版'), '查新版有 title')
  assert.ok(box.innerHTML.includes('title="复制手工命令'), '复制手工命令有 title')
  assert.ok(box.innerHTML.includes('title="复制已脱敏诊断'), '复制诊断有 title')
  panel.unmount()
})

test('单面板 dialog：Esc 停轮询（与关闭按钮同口径）', async () => {
  const { mountUpdatePanel } = await import('../dist/panel.js')
  const box = fakeContainer()
  let calls = 0
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    prefix: 't',
    mode: 'dialog',
    call: async () => {
      calls++
      return { ok: true, snapshot: null }
    },
    pollMs: 60000,
  })
  await tick()
  const n = calls
  box.key('Escape')
  box.click({ 'data-action': 'check' }) // 已卸载：act 直接返回，不再发 call
  await tick()
  assert.equal(calls, n, 'Esc 后不再发 call')
  assert.ok(box.innerHTML.includes('data-action="close-view"'), 'Esc 不清 HTML（与关闭按钮同口径，只停轮询）')
  panel.unmount()
})

test('批量：取消要点两次，点别的自动卸膛', async () => {
  const { mountUpdateBatchPanel } = await import('../dist/panel-batch.js')
  const box = fakeContainer()
  const calls = []
  const rows = [
    { key: 'a', pluginId: 'pa', phase: 'ready', runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.0.1' },
  ]
  const panel = mountUpdateBatchPanel(box, {
    pluginId: 'batch',
    prefix: 'b',
    call: async (phone) => {
      calls.push(phone)
      return { ok: true, session: { id: 's1' }, rows }
    },
    pollMs: 60000,
  })
  await tick()
  await tick()
  assert.ok(box.innerHTML.includes('取消这一批'), '常态文案')
  box.click({ 'data-act': 'cancel' })
  await tick()
  assert.ok(box.innerHTML.includes('确认取消这一批'), '第一次只上膛')
  assert.ok(!calls.some((c) => c.endsWith('.batchCancel')), '上膛不发取消电话')
  box.click({ 'data-act': 'check' }) // 点别的
  await tick()
  assert.ok(!box.innerHTML.includes('确认取消这一批'), '点别的自动卸膛')
  box.click({ 'data-act': 'cancel' })
  await tick()
  box.click({ 'data-act': 'cancel' })
  await tick()
  assert.ok(calls.some((c) => c.endsWith('.batchCancel')), '第二次才真取消')
  panel.unmount()
})

test('批量 dialog：Esc 可关（监听已挂上）', async () => {
  const { mountUpdateBatchPanel } = await import('../dist/panel-batch.js')
  const box = fakeContainer()
  let calls = 0
  const panel = mountUpdateBatchPanel(box, {
    pluginId: 'batch',
    prefix: 'b',
    mode: 'dialog',
    call: async () => {
      calls++
      return { ok: true, session: { id: 's1' }, rows: [] }
    },
    pollMs: 60000,
  })
  await tick()
  const n = calls
  box.key('Escape')
  await tick()
  assert.equal(calls, n, 'Esc 后无新 call（监听生效；轮询已停）')
  panel.unmount()
})

test('入口件 dialog：Esc 还原入口按钮', async () => {
  const { mountUpdateEntry } = await import('../dist/entry.js')
  const box = fakeContainer()
  const panel = mountUpdateEntry(box, {
    pluginId: 'p',
    prefix: 't',
    autoCheck: 'never',
    openOn: 'always',
    call: async () => ({ ok: true, snapshot: { runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: null, canInstall: false } }),
  })
  box.click({ 'data-dsh-upd-entry': 'activate' })
  await tick()
  await tick()
  assert.ok(box.innerHTML.includes('data-action="check"'), '弹窗已开（面板已挂载）')
  box.key('Escape')
  await tick()
  assert.ok(box.innerHTML.includes('data-dsh-upd-entry="activate"'), 'Esc 后还原入口按钮')
  panel.unmount()
})

test('spinner 与 title 样式串常驻', async () => {
  const { UPDATE_PANEL_CSS } = await import('../dist/panel.js')
  const { UPDATE_ENTRY_CSS } = await import('../dist/entry.js')
  const { UPDATE_BATCH_PANEL_CSS } = await import('../dist/panel-batch.js')
  assert.ok(UPDATE_PANEL_CSS.includes('dsh-upd-spin'), '面板有 spinner')
  assert.ok(UPDATE_PANEL_CSS.includes('dsh-upd-shimmer'), '面板有骨架微光')
  assert.ok(UPDATE_ENTRY_CSS.includes('dsh-upd-entry-spin'), '入口件有 spinner')
  assert.ok(UPDATE_BATCH_PANEL_CSS.includes('[data-confirm="1"]'), '批量有确认态样式')
})
