/**
 * tests/panel-mount-order.test.mjs —— #214 挂载校验证据：日志通道必须先于校验建好，
 * 于是容器/插件标识/前缀/轮询/形态/主题/主题令牌/语言（以及注入通道时的 call）每一种
 * 校验失败都恰好留一条 render.fail{phase:'mount', kind, errorHash:8位}。
 *
 * 分两路：注入通道（调用方自带通道）与默认集成（面板自建 <prefix>.logAppend 通道）。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel } from '../dist/panel.js'
import { mountInstallButton } from '../dist/install-button.js'
import { createClientLogChannel } from '../dist/log/client-queue.js'

const HASH = /^[0-9a-f]{8}$/

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function capturingChannel() {
  const batches = []
  const ch = createClientLogChannel({
    call: async (name, args) => {
      batches.push({ name, rows: Array.isArray(args?.rows) ? args.rows : [] })
      return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
    },
    phoneName: 'wf.logAppend',
    timer: null,
    visibility: null,
    batchSize: 1000,
  })
  return { ch, batches }
}

function fakeTransport() {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.logAppend')) {
      return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
    }
    throw new Error('unexpected-phone:' + name)
  }
  return { call, log }
}

async function settle(ms = 25) {
  await new Promise((r) => setTimeout(r, ms))
}

function mountFailRows(batches) {
  return batches.flatMap((b) => b.rows).filter((row) => row.event === 'update.panel.render.fail')
}

describe('#214 挂载校验失败证据（注入通道）', () => {
  const cases = [
    ['container', (channel) => [null, { pluginId: 'p', call: async () => ({}), clientLog: { channel } }]],
    ['plugin-id', (channel) => [fakeContainer(), { pluginId: '', call: async () => ({}), clientLog: { channel } }]],
    [
      'prefix',
      (channel) => [fakeContainer(), { pluginId: 'p', prefix: 'bad prefix', call: async () => ({}), clientLog: { channel } }],
    ],
    ['poll-ms', (channel) => [fakeContainer(), { pluginId: 'p', pollMs: 100, call: async () => ({}), clientLog: { channel } }]],
    ['mode', (channel) => [fakeContainer(), { pluginId: 'p', mode: 'weird', call: async () => ({}), clientLog: { channel } }]],
    ['theme', (channel) => [fakeContainer(), { pluginId: 'p', theme: 'weird', call: async () => ({}), clientLog: { channel } }]],
    [
      'theme-tokens',
      (channel) => [fakeContainer(), { pluginId: 'p', themeTokens: { accent: 42 }, call: async () => ({}), clientLog: { channel } }],
    ],
    ['locale', (channel) => [fakeContainer(), { pluginId: 'p', locale: '', call: async () => ({}), clientLog: { channel } }]],
    ['call', (channel) => [fakeContainer(), { pluginId: 'p', clientLog: { channel } }]],
  ]

  for (const [kind, make] of cases) {
    test(`挂载校验失败：${kind} 恰好一条 phase=mount 的证据行`, async () => {
      const cap = capturingChannel()
      assert.throws(() => mountUpdatePanel(...make(cap.ch)))
      await settle()
      await cap.ch.flush()
      await settle()
      const fails = mountFailRows(cap.batches)
      assert.equal(fails.length, 1, `只留一条，实际 ${fails.length}`)
      assert.equal(fails[0].level, 'error')
      assert.equal(fails[0].fields.phase, 'mount')
      assert.equal(fails[0].fields.kind, kind)
      assert.match(fails[0].fields.errorHash, HASH)
    })
  }
})

describe('#214 挂载校验失败证据（默认集成：面板自建通道）', () => {
  const cases = [
    ['container', () => [null, { pluginId: 'p' }]],
    ['plugin-id', () => [fakeContainer(), { pluginId: '' }]],
    ['prefix', () => [fakeContainer(), { pluginId: 'p', prefix: 'bad prefix' }]],
    ['poll-ms', () => [fakeContainer(), { pluginId: 'p', pollMs: 100 }]],
    ['mode', () => [fakeContainer(), { pluginId: 'p', mode: 'weird' }]],
    ['theme', () => [fakeContainer(), { pluginId: 'p', theme: 'weird' }]],
    ['theme-tokens', () => [fakeContainer(), { pluginId: 'p', themeTokens: { accent: 42 } }]],
    ['locale', () => [fakeContainer(), { pluginId: 'p', locale: '' }]],
  ]

  for (const [kind, make] of cases) {
    test(`默认集成：${kind} 失败经自建通道落到 <prefix>.logAppend`, async () => {
      const transport = fakeTransport()
      const [box, options] = make()
      assert.throws(() => mountUpdatePanel(box, { ...options, call: transport.call }))
      await settle()
      const rows = transport.log.flatMap((c) => (c.name.endsWith('.logAppend') ? c.args.rows : []))
      const fails = rows.filter((row) => row.event === 'update.panel.render.fail')
      assert.equal(fails.length, 1, `只留一条，实际 ${fails.length}：${rows.map((r) => r.event).join(',')}`)
      assert.equal(fails[0].fields.phase, 'mount')
      assert.equal(fails[0].fields.kind, kind)
      assert.match(fails[0].fields.errorHash, HASH)
      assert.ok(
        transport.log.some((c) => c.name === 'wf.logAppend'),
        '前缀非法时也回落到安全前缀，不因证据丢路由'
      )
    })
  }
})

describe('#214 安装按钮同构：挂载校验失败也留证据', () => {
  test('auto-check 非法：phase=mount、kind=auto-check', async () => {
    const cap = capturingChannel()
    assert.throws(() =>
      mountInstallButton(fakeContainer(), {
        pluginId: 'p',
        call: async () => ({}),
        autoCheck: 'bogus',
        clientLog: { channel: cap.ch },
      })
    )
    await settle()
    await cap.ch.flush()
    const fails = mountFailRows(cap.batches)
    assert.equal(fails.length, 1)
    assert.equal(fails[0].fields.phase, 'mount')
    assert.equal(fails[0].fields.kind, 'auto-check')
    assert.match(fails[0].fields.errorHash, HASH)
  })

  test('主题令牌非法：phase=mount、kind=theme-tokens', async () => {
    const cap = capturingChannel()
    assert.throws(() =>
      mountInstallButton(fakeContainer(), {
        pluginId: 'p',
        call: async () => ({}),
        themeTokens: { accent: 42 },
        clientLog: { channel: cap.ch },
      })
    )
    await settle()
    await cap.ch.flush()
    const fails = mountFailRows(cap.batches)
    assert.equal(fails.length, 1)
    assert.equal(fails[0].fields.kind, 'theme-tokens')
  })
})
