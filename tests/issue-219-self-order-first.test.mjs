/**
 * #219：爱生活本体作为批量面板第一行 + 在装按钮只留一枚转圈。
 *
 * 1. orderTargets 默认仍把自己排最后（自更新安全），传 'first' 时排第一；
 * 2. createBatchSession 把 selfOrder 带进 order/entries（本体占第一行）；
 * 3. 批量宿主端 selfOrder='first' 时 batchCheck 返回的会话第一行就是本体；缺省仍是最后；
 * 4. 批量在装按钮的 CSS 关掉单面板主题给 [aria-busy] 按钮自带的 ::after 转圈，避免双转条。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBatchSession, orderTargets } from '../dist/core/batch/model.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { UPDATE_BATCH_PANEL_CSS } from '../dist/panel-batch.js'
import { fakeTransport, mkScope, mkTarget, unbindAll } from './helpers/batch-log-harness.mjs'

test('orderTargets：默认把自己排最后，selfOrder=first 时本体第一', () => {
  assert.deepEqual(orderTargets(['self', 'a', 'b'], 'self'), ['a', 'b', 'self'])
  assert.deepEqual(orderTargets(['self', 'a', 'b'], 'self', 'first'), ['self', 'a', 'b'])
  assert.deepEqual(orderTargets(['x', 'a'], 'missing'), ['x', 'a'], '未知 selfKey 不影响顺序')
  assert.deepEqual(orderTargets(['self', 'a', 'self', 'b'], 'self', 'first'), ['self', 'a', 'b'], '去重且本体第一')
})

test('createBatchSession：selfOrder 决定 order 与 entries 首行', () => {
  const last = createBatchSession({ id: 's-last', keys: ['self', 'a', 'b'], selfKey: 'self', now: 1 })
  assert.deepEqual(last.order, ['a', 'b', 'self'])
  assert.deepEqual(last.entries.map((entry) => entry.key), ['a', 'b', 'self'])

  const first = createBatchSession({
    id: 's-first',
    keys: ['a', 'self', 'b'],
    selfKey: 'self',
    selfOrder: 'first',
    now: 1,
  })
  assert.deepEqual(first.order, ['self', 'a', 'b'])
  assert.deepEqual(first.entries.map((entry) => entry.key), ['self', 'a', 'b'])
  assert.equal(first.entries[0].requestId, 'batch:s-first:self')
})

test('批量宿主：selfOrder=first 时第一行是本体；缺省仍是最后一行', async () => {
  try {
    const firstHost = createMultiHostUpdate(
      { scope: (await mkScope('issue219-first-')).scope, transport: fakeTransport({}) },
      { prefix: 'life', targets: [mkTarget('self'), mkTarget('a')], selfKey: 'self', selfOrder: 'first' },
    )
    const firstReply = await firstHost.handlers['life.batchInstall']({})
    assert.equal(firstReply.ok, true)
    assert.deepEqual(firstReply.session.order, ['self', 'a'])
    assert.equal(firstReply.rows[0].key, 'self', '本体占第一行')

    const lastHost = createMultiHostUpdate(
      { scope: (await mkScope('issue219-last-')).scope, transport: fakeTransport({}) },
      { prefix: 'life', targets: [mkTarget('self'), mkTarget('a')], selfKey: 'self' },
    )
    const lastReply = await lastHost.handlers['life.batchInstall']({})
    assert.deepEqual(lastReply.session.order, ['a', 'self'], '缺省仍自更新安全：本体排最后')
  } finally {
    unbindAll()
  }
})

test('在装按钮只留一枚转圈：主题的 ::after 被显式关掉', () => {
  const css = String(UPDATE_BATCH_PANEL_CSS)
  assert.ok(
    css.includes('.dsh-upd-busy-btn[aria-busy="true"]::after{content:none'),
    '缺 ::after 关停规则（否则主题那枚转圈会和我们 ::before 叠成双转条）',
  )
  assert.equal(
    (css.match(/dsh-upd-busy-btn:disabled::before/g) ?? []).length,
    1,
    '::before 转圈只应有一条',
  )
})
