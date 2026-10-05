// tests/panel-busy.test.mjs —— #36：在途忙态与按钮交互反馈。
// 点下查新版/安装到回包前的那一帧，按钮必须当即置忙（禁用 + 文案 + aria-busy），
// 并发连点只发一次 call；回包后恢复。CSS 反馈类规则常驻。
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
  }
}

const SNAP_OK = {
  runningVersion: '0.3.0',
  installedVersion: '0.3.0',
  latestVersion: '0.3.1',
  canInstall: true,
}

function deferredCall(handler) {
  const pending = []
  const calls = []
  const call = (phone, args) =>
    new Promise((resolve) => {
      calls.push(phone)
      pending.push(() => resolve(handler(phone, args)))
    })
  return { call, calls, pending }
}

test('查新版：在途当即置忙，回包后恢复', async () => {
  const { mountUpdatePanel } = await import('../dist/panel.js')
  const box = fakeContainer()
  const { call, calls, pending } = deferredCall((phone) =>
    phone.endsWith('.updateCheck')
      ? { ok: true, snapshot: SNAP_OK, receipt: { checkId: 'c1' } }
      : { ok: true, snapshot: { ...SNAP_OK, latestVersion: null, canInstall: false } },
  )
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000 })
  pending.shift()() // 首轮 refresh 回包
  await tick()
  box.click({ 'data-action': 'check' })
  await tick()
  assert.ok(box.innerHTML.includes('正在查新版…'), '在途文案当即出现')
  assert.ok(box.innerHTML.includes('aria-busy="true"'), '在途带 aria-busy')
  assert.equal(calls.filter((c) => c === 't.updateCheck').length, 1)
  pending.shift()() // 查新版回包
  await tick()
  assert.ok(!box.innerHTML.includes('正在查新版…'), '回包后恢复')
  assert.ok(box.innerHTML.includes('0.3.1'), '回包快照落到界面')
  panel.unmount()
})

test('查新版：并发连点只发一次 call', async () => {
  const { mountUpdatePanel } = await import('../dist/panel.js')
  const box = fakeContainer()
  const calls = []
  const hanging = async (phone) => {
    calls.push(phone)
    return new Promise(() => {}) // 故意挂起：不断言结果，只数 call 次数
  }
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call: hanging, pollMs: 60000 })
  await tick()
  box.click({ 'data-action': 'check' })
  box.click({ 'data-action': 'check' })
  box.click({ 'data-action': 'check' })
  await tick()
  assert.equal(
    calls.filter((c) => c === 't.updateCheck').length,
    1,
    '在途中的重复点击不许再发 call',
  )
  panel.unmount()
})

test('安装：在途按钮置忙（正在安装…）', async () => {
  const { mountUpdatePanel } = await import('../dist/panel.js')
  const box = fakeContainer()
  const order = []
  const call = (phone) => {
    order.push(phone)
    if (phone.endsWith('.updateCheck')) return Promise.resolve({ ok: true, snapshot: SNAP_OK, receipt: { checkId: 'c9' } })
    if (phone.endsWith('.updateInstall')) return new Promise(() => {}) // 故意挂起
    return Promise.resolve({ ok: true, snapshot: { ...SNAP_OK, latestVersion: null, canInstall: false } })
  }
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000 })
  await tick()
  await tick()
  box.click({ 'data-action': 'install' })
  await tick()
  await tick()
  assert.ok(box.innerHTML.includes('正在安装…'), '安装在途文案出现')
  assert.ok(order.includes('t.updateInstall'), '安装电话已发出')
  panel.unmount()
})

test('入口件：点击后在途置忙，挂起时不再像死按钮', async () => {
  const { mountUpdateEntry } = await import('../dist/entry.js')
  const box = fakeContainer()
  let release = null
  const gate = new Promise((res) => {
    release = res
  })
  const call = async (phone) => {
    if (phone.endsWith('.updateCheck')) await gate
    return { ok: true, snapshot: SNAP_OK }
  }
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 't', call, autoCheck: 'never' })
  box.click({ 'data-dsh-upd-entry': 'activate' })
  await tick()
  assert.ok(box.innerHTML.includes('正在查新版…'), '入口件在途文案出现')
  assert.ok(box.innerHTML.includes('disabled'), '入口件按钮在途禁用')
  release()
  await tick()
  await tick()
  assert.ok(!box.innerHTML.includes('正在查新版…'), '回包后恢复')
  entry.unmount()
})

test('反馈 CSS 常驻：hover / active / busy 脉冲 / reduced-motion', async () => {
  const { UPDATE_PANEL_CSS } = await import('../dist/panel.js')
  const { UPDATE_ENTRY_CSS } = await import('../dist/entry.js')
  for (const rule of [
    '.dsh-upd button:hover:not(:disabled)',
    '.dsh-upd button:active:not(:disabled)',
    '.dsh-upd button[aria-busy="true"]',
    'dsh-upd-pulse',
    'prefers-reduced-motion',
  ]) {
    assert.ok(UPDATE_PANEL_CSS.includes(rule), '面板 CSS 须含 ' + rule)
  }
  for (const rule of [
    '.dsh-upd-entry-btn:active:not(:disabled)',
    '.dsh-upd-entry-btn:disabled',
    'prefers-reduced-motion',
  ]) {
    assert.ok(UPDATE_ENTRY_CSS.includes(rule), '入口件 CSS 须含 ' + rule)
  }
})
