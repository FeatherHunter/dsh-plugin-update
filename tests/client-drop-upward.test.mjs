/**
 * tests/client-drop-upward.test.mjs —— #214 客户端队列丢弃上浮：每种「丢掉了什么」都要有交代。
 *
 * 能投递的三种原因（overflow / host-refused / send-failed）在每个通道内各自上浮一条
 * update.log.degraded{reason:'client-drop-<reason>'}，同类终身只一条（防刷）；
 * 物理上无法投递的两种（no-channel / disposed）只能留在 droppedByReason() 里，
 * 由面板的复制诊断「连接」计数段交代。dispose 前先尽量冲刷。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClientLogChannel, isClientLogEvent } from '../dist/log/client-queue.js'

function fakeCall(script = {}) {
  const calls = []
  const call = async (name, args) => {
    calls.push({ name, args })
    if (script.throwAlways) throw new Error('boom')
    if (typeof script.throwFirst === 'number' && calls.length <= script.throwFirst) throw new Error('boom')
    if (script.reply) return script.reply(args)
    return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
  }
  return { call, calls }
}

function channel(overrides = {}) {
  const { call, calls } = fakeCall(overrides.script ?? {})
  const ch = createClientLogChannel({
    call,
    phoneName: 'wf.logAppend',
    timer: null,
    visibility: null,
    batchSize: 1000,
    ...overrides.options,
  })
  return { ch, calls }
}

async function settle() {
  await new Promise((r) => setTimeout(r, 5))
}

function rowsOf(calls) {
  return calls.flatMap((c) => c.args?.rows ?? [])
}

function degradedRows(calls, reason) {
  return rowsOf(calls).filter((r) => r.event === 'update.log.degraded' && r.fields.reason === reason)
}

describe('#214 客户端丢弃上浮：可投递的三种原因各上浮一条且只一条', () => {
  it('overflow：挤掉的最老是它的证据；同类再次发生不再刷行', async () => {
    const { ch, calls } = channel({ options: { maxQueue: 2 } })
    for (const action of ['a', 'b', 'c', 'd']) ch.emit('info', 'update.panel.action', { action })
    assert.equal(ch.dropped(), 2)
    await ch.flush()
    await ch.flush()
    const upfloat = degradedRows(calls, 'client-drop-overflow')
    assert.equal(upfloat.length, 1)
    assert.equal(upfloat[0].level, 'warn')
    assert.equal(isClientLogEvent(upfloat[0].event), true, '上浮行本身也走客户端白名单')
    assert.deepEqual(ch.droppedByReason(), { overflow: 2 })

    for (const action of ['e', 'f', 'g']) ch.emit('info', 'update.panel.action', { action })
    await ch.flush()
    await ch.flush()
    assert.equal(degradedRows(calls, 'client-drop-overflow').length, 1, '同一原因终身只报一次')
  })

  it('host-refused：回包说丢了几行，就上浮几行的事实（只一条行）', async () => {
    const { ch, calls } = channel({ script: { reply: () => ({ accepted: 1, dropped: 2 }) } })
    ch.emit('info', 'update.panel.action', { action: 'check' })
    ch.emit('info', 'update.panel.action', { action: 'install' })
    ch.emit('info', 'update.panel.action', { action: 'close-view' })
    await ch.flush()
    assert.deepEqual(ch.droppedByReason(), { 'host-refused': 2 })
    await ch.flush()
    const upfloat = degradedRows(calls, 'client-drop-host-refused')
    assert.equal(upfloat.length, 1)
    assert.equal(upfloat[0].level, 'warn')
    assert.ok(!/^client-drop-host-refused-/.test(upfloat[0].fields.reason), '原因字符串是稳定码，不带计数')
  })

  it('send-failed：传输失败整批丢，上浮一条传输事实（下一批恢复后送达）', async () => {
    const { ch, calls } = channel({ script: { throwFirst: 3 }, options: { retryDelaysMs: [1, 1] } })
    ch.emit('info', 'update.panel.action', { action: 'check' })
    await ch.flush()
    assert.equal(ch.sent(), 0)
    assert.deepEqual(ch.droppedByReason(), { 'send-failed': 1 })
    assert.equal(ch.pending(), 1, '上浮行自己排进下一批')
    const before = rowsOf(calls).filter((r) => r.event === 'update.log.degraded')
    assert.equal(before.length, 0, '失败的那一批里只有被丢的行')
    await ch.flush()
    const upfloat = degradedRows(calls, 'client-drop-send-failed')
    assert.equal(upfloat.length, 1, '下一批恢复后把丢弃事实交出去')
  })
})

describe('#214 客户端丢弃上浮：投不出去的两种原因只留计数', () => {
  it('no-channel：没有传输时一个字节都发不出去，计数如实留着', async () => {
    const ch = createClientLogChannel({ call: null, phoneName: '', timer: null, visibility: null })
    ch.emit('info', 'update.panel.action', { action: 'check' })
    assert.deepEqual(ch.droppedByReason(), { 'no-channel': 1 })
    assert.equal(ch.pending(), 0)
    await assert.doesNotReject(() => ch.flush())
    assert.deepEqual(ch.droppedByReason(), { 'no-channel': 1 })
  })

  it('disposed：终止后再报的行计数留着（没有终点了，不假装能送）', async () => {
    const { ch } = channel()
    ch.dispose()
    await settle()
    ch.emit('info', 'update.panel.action', { action: 'check' })
    assert.deepEqual(ch.droppedByReason(), { disposed: 1 })
    assert.equal(ch.pending(), 0)
  })
})

describe('#214 终止前尽量冲刷', () => {
  it('dispose 把攒着的行先发完再关张', async () => {
    const { ch, calls } = channel()
    ch.emit('info', 'update.panel.mount', { mode: 'panel' })
    ch.dispose()
    await settle()
    assert.equal(calls.length, 1, '终止前最后一次 flush')
    assert.equal(calls[0].args.rows.length, 1)
    assert.equal(ch.sent(), 1)
    assert.equal(ch.dropped(), 0)
  })

  it('dispose 时传输失败：行计入丢弃但绝不再外抛', async () => {
    const { ch } = channel({ script: { throwAlways: true }, options: { retryDelaysMs: [1, 1] } })
    ch.emit('info', 'update.panel.action', { action: 'check' })
    assert.doesNotThrow(() => ch.dispose())
    await settle()
    assert.equal(ch.sent(), 0)
    assert.equal(ch.dropped(), 1)
    assert.deepEqual(ch.droppedByReason(), { 'send-failed': 1 }, '发不出去的行仍如实记账')
  })
})
