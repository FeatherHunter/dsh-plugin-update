/**
 * tests/panel-render-fail.test.mjs —— #214 渲染/轮询/全局兜底的失败证据：
 * 同阶段同类别同指纹 60 秒内至多一条（边沿去重）；全局兜底只记指纹；
 * 轮询传输失败不承诺落盘，但连续失败计数进复制诊断的「连接」段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel } from '../dist/panel.js'
import { hash8 } from '../dist/hash.js'
import { createClientLogChannel } from '../dist/log/client-queue.js'

function baseSnapshot() {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    job: null,
  }
}

function fakeStatus() {
  return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: { busy: false, owner: null, waiting: [], position: null } }
}

function fakeCall(script = {}) {
  const call = async (name, args) => {
    if (name.endsWith('.updateStatus')) {
      if (script.statusThrows) throw new Error(script.statusThrows)
      return fakeStatus()
    }
    if (name.endsWith('.logAppend')) return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
    throw new Error('unexpected-phone:' + name)
  }
  return { call }
}

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

async function settle(ms = 25) {
  await new Promise((r) => setTimeout(r, ms))
}

async function flushRows(ch, batches) {
  await settle()
  await ch.flush()
  await settle()
  return batches.flatMap((b) => b.rows)
}

function renderFailRows(rows) {
  return rows.filter((row) => row.event === 'update.panel.render.fail')
}

test('#214 paint 抛错：一条 phase=paint 的边沿证据，60 秒窗口内不重复', async () => {
  const cap = capturingChannel()
  const { call } = fakeCall()
  // 渲染体里唯一没被 setStableHTML 吞掉的可注入点：跳过清单查询。
  const throwingSkipStore = {
    list: () => [],
    has: () => {
      throw new Error('paint-boom')
    },
    skip() {},
    reset() {},
  }
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call,
    pollMs: 60000,
    skipStore: throwingSkipStore,
    clientLog: { channel: cap.ch },
  })
  await settle()
  await panel.refresh()
  await panel.refresh()
  const fails = renderFailRows(await flushRows(cap.ch, cap.batches))
  assert.equal(fails.length, 1, `同指纹只留一条，实际 ${fails.length}`)
  assert.equal(fails[0].level, 'error')
  assert.deepEqual(fails[0].fields, { phase: 'paint', kind: 'render', errorHash: hash8('paint-boom') })
  panel.unmount()
})

test('#214 轮询传输失败：一条 phase=poll 证据；计数进复制诊断「连接」段', async () => {
  const cap = capturingChannel()
  const texts = []
  const { call } = fakeCall({ statusThrows: 'poll-boom' })
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call,
    pollMs: 60000,
    copyText: async (t) => texts.push(t),
    clientLog: { channel: cap.ch },
  })
  await settle()
  await panel.refresh()
  await panel.refresh()
  const fails = renderFailRows(await flushRows(cap.ch, cap.batches))
  assert.equal(fails.length, 1, '同一传输错误指纹只留一条')
  assert.equal(fails[0].fields.phase, 'poll')
  assert.equal(fails[0].fields.kind, 'transport')
  assert.equal(fails[0].fields.errorHash, hash8('poll-boom'))

  await panel.act('copy-diag')
  assert.equal(texts.length, 1)
  assert.match(texts[0], /传输失败 [1-9]\d* 次/, `复制诊断要带连接计数：${texts[0]}`)
  assert.ok(texts[0].includes('客户端丢弃 0 行'), '没有客户端丢弃就写 0，不省略计数段')
  panel.unmount()
})

test('#214 全局兜底：window error / unhandledrejection 只在有监听器时接线，只记指纹，卸载即摘', async () => {
  const cap = capturingChannel()
  const listeners = new Map()
  const hadAdd = Object.prototype.hasOwnProperty.call(globalThis, 'addEventListener')
  const hadRemove = Object.prototype.hasOwnProperty.call(globalThis, 'removeEventListener')
  const beforeAdd = globalThis.addEventListener
  const beforeRemove = globalThis.removeEventListener
  globalThis.addEventListener = (type, fn) => listeners.set(type, fn)
  globalThis.removeEventListener = (type) => listeners.delete(type)
  try {
    const { call } = fakeCall()
    const panel = mountUpdatePanel(fakeContainer(), {
      pluginId: 'p',
      call,
      pollMs: 60000,
      clientLog: { channel: cap.ch },
    })
    assert.equal(typeof listeners.get('error'), 'function')
    assert.equal(typeof listeners.get('unhandledrejection'), 'function')

    listeners.get('error')({ message: 'global-boom' })
    listeners.get('unhandledrejection')({ reason: new Error('rej-boom') })
    const fails = renderFailRows(await flushRows(cap.ch, cap.batches))
    const global = fails.filter((row) => row.fields.phase === 'global')
    assert.equal(global.length, 2)
    const uncaught = global.find((row) => row.fields.kind === 'uncaught')
    const unhandled = global.find((row) => row.fields.kind === 'unhandled')
    assert.deepEqual(uncaught.fields, { phase: 'global', kind: 'uncaught', errorHash: hash8('global-boom') })
    assert.deepEqual(unhandled.fields, { phase: 'global', kind: 'unhandled', errorHash: hash8('rej-boom') })
    assert.ok(
      !JSON.stringify(global).includes('global-boom'),
      '全局兜底只留指纹，绝不把原话写进日志'
    )

    panel.unmount()
    assert.equal(listeners.size, 0, '卸载即摘监听器')
  } finally {
    if (hadAdd) globalThis.addEventListener = beforeAdd
    else delete globalThis.addEventListener
    if (hadRemove) globalThis.removeEventListener = beforeRemove
    else delete globalThis.removeEventListener
  }
})
