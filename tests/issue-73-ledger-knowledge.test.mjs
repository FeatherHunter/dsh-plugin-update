/**
 * tests/issue-73-ledger-knowledge.test.mjs —— #73 总账吃知识：pending 行按知识计数。
 *
 * 只测外部行为：batchLedgerCounts 的知识映射 + renderBatchPanelHTML 同屏一致性。
 * 口径（推荐 A）：无轮次 pending 行有新版进可更新、已最新进 settled、无知识仍待查、
 * 知识查失败进失败；checking 行永远走执行态（待查），不吃知识。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { batchLedgerCounts, batchLedgerText, renderBatchPanelHTML } from '../dist/panel-batch.js'

function rowOf(o = {}) {
  return { key: 'a', title: '甲', phase: 'pending', targetVersion: null, restartRequired: false, error: null, snapshot: null, manual: null, queue: null, profileName: null, ...o }
}
function emptySession() {
  return { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 }
}
function invEntry(o = {}) {
  return { lastCheckedAt: 1, installedVersion: '0.3.44', latestVersion: '0.3.46', canInstall: true, error: null, ...o }
}
function invOf(entries) {
  return { version: 1, updatedAt: 1, entries }
}
function countOf(html, word) {
  return html.split(word).length - 1
}

describe('#73：空会话 + 知识有新版不再矛盾', () => {
  it('7 行 pending + 知识 0.3.44→0.3.46：总账 updatable:7、hint 可更新、同屏无还没查过', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => rowOf({ key: k }))
    const entries = {}
    for (const r of rows) entries[r.key] = invEntry()
    const inventory = invOf(entries)
    const counts = batchLedgerCounts(rows, inventory)
    assert.equal(counts.updatable, 7)
    assert.equal(counts.pending, 0)
    assert.equal(counts.updatable + counts.installing + counts.pending + counts.restart + counts.failed + counts.skipped + counts.settled, 7)
    const html = renderBatchPanelHTML({ rows, session: emptySession(), inventory, lang: 'zh' })
    assert.ok(!html.includes('还没查过'), '顶部/底部不再报还没查过')
    assert.ok(html.includes('7 家可更新'), 'hint 走可更新')
    assert.ok(countOf(html, '有新版') >= 7, '行仍显示 7 处有新版')
    assert.ok(html.includes('7 家可更新'), '底部总账同步可更新')
  })

  it('知识已是最新：进 settled，hint 全部已最新', () => {
    const rows = [rowOf({ key: 'a' })]
    const inventory = invOf({ a: invEntry({ installedVersion: '0.3.46', latestVersion: '0.3.46' }) })
    const counts = batchLedgerCounts(rows, inventory)
    assert.equal(counts.settled, 1)
    assert.equal(counts.pending, 0)
    const html = renderBatchPanelHTML({ rows, session: emptySession(), inventory, lang: 'zh' })
    assert.ok(html.includes('全部已最新'), 'hint 走 done')
    assert.ok(html.includes('已是最新'), '行显示已是最新')
  })

  it('无知识：仍 pending（零回归）', () => {
    const rows = [rowOf({ key: 'a' })]
    const counts = batchLedgerCounts(rows)
    assert.equal(counts.pending, 1)
    const html = renderBatchPanelHTML({ rows, session: emptySession(), lang: 'zh' })
    assert.ok(html.includes('还没查过'), '无知识仍提示还没查过')
  })

  it('知识查失败：进 failed，与行失败文案一致', () => {
    const rows = [rowOf({ key: 'a' })]
    const inventory = invOf({ a: invEntry({ latestVersion: null, error: 'check-failed' }) })
    const counts = batchLedgerCounts(rows, inventory)
    assert.equal(counts.failed, 1)
    assert.equal(counts.pending, 0)
  })

  it('checking 行不吃知识：永远待查', () => {
    const rows = [rowOf({ key: 'a', phase: 'checking' })]
    const inventory = invOf({ a: invEntry() })
    const counts = batchLedgerCounts(rows, inventory)
    assert.equal(counts.pending, 1)
    assert.equal(counts.updatable, 0)
  })

  it('有轮次未终态：hint 仍走安装中，ledger 安装中 + 可更新', () => {
    const rows = [rowOf({ key: 'a', phase: 'installing' }), rowOf({ key: 'b', phase: 'pending' })]
    const inventory = invOf({ b: invEntry() })
    const session = { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: ['a', 'b'], entries: [{ key: 'a', phase: 'installing' }, { key: 'b', phase: 'pending' }], createdAt: 0, updatedAt: 0 }
    const counts = batchLedgerCounts(rows, inventory)
    assert.equal(counts.installing, 1)
    assert.equal(counts.updatable, 1)
    const html = renderBatchPanelHTML({ rows, session, inventory, lang: 'zh' })
    assert.ok(html.includes('正在安装'), 'hint 走安装中分支')
    assert.ok(!html.includes('还没查过'), '知识行不回退还没查过')
  })

  it('总账文本同步：有新版时底部 ledger 含可更新', () => {
    const rows = [rowOf({ key: 'a' })]
    const counts = batchLedgerCounts(rows, invOf({ a: invEntry() }))
    assert.ok(batchLedgerText(counts, 'zh').includes('可更新'), 'ledger 文本同步')
  })
});