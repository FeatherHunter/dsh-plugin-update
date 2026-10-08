/**
 * tests/issue-73-ledger-knowledge.test.mjs —— #73 总账吃知识（口径 = #82 报告 §6 推荐 A）。
 *
 * 只测外部行为：batchLedgerCounts 的知识映射 + renderBatchPanelHTML 同一屏一致 + 入口徽标同口径。
 * 口径三条（#82 报告 §6.1–§6.3、§7 测试 4；#73 triage Agent Brief）：
 *   1. 无轮次 pending 行有新版 → 进可更新（顶部 hint 与底部 ledger 同步，与行同口径）；
 *   2. 有轮次未做完（inRound）→ 仍走执行态，总账不吃知识（按旧相位计数，inRound 语义不动）；
 *   3. 知识只回答「有没有新版 / 已是最新 / 这次没查到」：查失败的行文案是「这次没查到」，
 *      不许算成安装失败——否则顶部会喊「N 家安装失败；照下面的失败提示逐家重试」，而下面根本没有失败提示。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { batchLedgerCounts, batchLedgerText, mountUpdateBatchPanel, renderBatchPanelHTML } from '../dist/panel-batch.js'
import { batchEntrySummary, mountUpdateBatchEntry } from '../dist/entry-batch.js'

function rowOf(o = {}) {
  return { key: 'a', title: '甲', phase: 'pending', targetVersion: null, restartRequired: false, error: null, snapshot: null, manual: null, queue: null, profileName: null, ...o }
}
function emptySession() {
  return { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 }
}
/** 有轮次未做完：entries 里这些 key 停在非终态相位。 */
function roundSession(keys, phase = 'pending') {
  return { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: keys, entries: keys.map((key) => ({ key, phase })), createdAt: 0, updatedAt: 0 }
}
/** 上一轮已收尾：entries 全终态（行该回到知识口径）。 */
function finishedSession(keys) {
  return roundSession(keys, 'done')
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
/** 顶部一句话总账的纯文本。 */
function sumTextOf(html) {
  const m = html.match(/<div class="dsh-upd-batch-sum"[^>]*>([\s\S]*?)<\/div>/)
  return m ? m[1] : ''
}
/** 表下分类总账的纯文本。 */
function ledgerTextOf(html) {
  const m = html.match(/<div class="dsh-upd-batch-ledger">([\s\S]*?)<\/div>/)
  return m ? m[1] : ''
}
const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

describe('#73：空会话 + 知识有新版不再矛盾', () => {
  it('7 行 pending + 知识 0.3.44→0.3.46：总账 updatable:7、hint 可更新、同屏无还没查过', () => {
    const rows = seven.map((k) => rowOf({ key: k }))
    const entries = {}
    for (const r of rows) entries[r.key] = invEntry()
    const inventory = invOf(entries)
    const counts = batchLedgerCounts(rows, inventory)
    assert.equal(counts.updatable, 7)
    assert.equal(counts.pending, 0)
    assert.equal(counts.updatable + counts.installing + counts.pending + counts.restart + counts.failed + counts.skipped + counts.settled, 7)
    const html = renderBatchPanelHTML({ rows, session: emptySession(), inventory, lang: 'zh' })
    assert.ok(!html.includes('还没查过'), '顶部/底部不再报还没查过')
    assert.equal(sumTextOf(html), '7 家可更新；点「全部更新」一次安装完，也可以逐家点「安装这家」。', 'hint 走可更新')
    assert.equal(countOf(html, '有新版 0.3.46'), 7, '行仍显示 7 处有新版')
    assert.equal(ledgerTextOf(html), '7 家可更新', '底部总账同步可更新')
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

  it('知识查失败：行说「这次没查到」，总账就归待查，不冒充安装失败', () => {
    const rows = [rowOf({ key: 'a' })]
    const inventory = invOf({ a: invEntry({ latestVersion: null, error: 'check-failed' }) })
    const counts = batchLedgerCounts(rows, inventory)
    assert.equal(counts.failed, 0, '查失败不是安装失败，不进失败档')
    assert.equal(counts.pending, 1, '没有结果 = 还没结果，归待查')
    const html = renderBatchPanelHTML({ rows, session: emptySession(), inventory, lang: 'zh' })
    assert.ok(html.includes('这次没查到'), '行文案仍是这次没查到（知识事实）')
    assert.equal(sumTextOf(html), '1 家还没查过；点「检查更新」查一轮。', '顶部给可执行的重查，不喊安装失败')
    assert.ok(!sumTextOf(html).includes('安装失败'), '顶部不许出现安装失败')
    assert.ok(!sumTextOf(html).includes('失败提示'), '顶部不许指向不存在的失败提示')
  })

  it('checking 行不吃知识：永远待查', () => {
    const rows = [rowOf({ key: 'a', phase: 'checking' })]
    const inventory = invOf({ a: invEntry() })
    const counts = batchLedgerCounts(rows, inventory)
    assert.equal(counts.pending, 1)
    assert.equal(counts.updatable, 0)
  })

  it('总账文本同步：有新版时底部 ledger 含可更新', () => {
    const rows = [rowOf({ key: 'a' })]
    const counts = batchLedgerCounts(rows, invOf({ a: invEntry() }))
    assert.ok(batchLedgerText(counts, 'zh').includes('可更新'), 'ledger 文本同步')
  })
})

describe('#73 补：有轮次未做完仍走执行态（#82 §6.3 / §7 测试 4）', () => {
  it('轮次未做完 + 知识有新版：总账不吃知识，与行的执行态同口径', () => {
    const rows = ['a', 'b'].map((k) => rowOf({ key: k, title: k }))
    const inventory = invOf({ a: invEntry(), b: invEntry() })
    const session = roundSession(['a', 'b'])
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.pending, 2, '在轮里的 pending 行按旧相位计，不吃知识')
    assert.equal(counts.updatable, 0, '不许把在轮的行算成可更新')
    const html = renderBatchPanelHTML({ rows, session, inventory, lang: 'zh' })
    assert.equal(countOf(html, '有新版 0.3.46'), 0, '行也不吃知识（inRound 走执行态）')
    assert.equal(countOf(html, '等它，轮到就自动查新版'), 2, '行是执行态的等待词')
    assert.equal(sumTextOf(html), '2 家还没查过；点「检查更新」查一轮。', '顶部与行同为执行态')
    assert.equal(ledgerTextOf(html), '2 家待查', '底部同为执行态')
  })

  it('轮次未做完 + 知识查失败：仍待查，不喊安装失败', () => {
    const rows = [rowOf({ key: 'a' })]
    const inventory = invOf({ a: invEntry({ latestVersion: null, error: 'check-failed' }) })
    const session = roundSession(['a'])
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.pending, 1)
    assert.equal(counts.failed, 0)
    const html = renderBatchPanelHTML({ rows, session, inventory, lang: 'zh' })
    assert.ok(!sumTextOf(html).includes('安装失败'), '顶部不喊安装失败')
  })

  it('轮次已收尾（entries 全终态）：回到知识口径，行与总账一起看知识', () => {
    const rows = [rowOf({ key: 'a' })]
    const inventory = invOf({ a: invEntry() })
    const session = finishedSession(['a'])
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.updatable, 1, '终态轮次不算没做完，行已回到知识展示')
    const html = renderBatchPanelHTML({ rows, session, inventory, lang: 'zh' })
    assert.equal(countOf(html, '有新版 0.3.46'), 1, '行显示有新版')
    assert.ok(!html.includes('还没查过'), '总账同步为可更新')
  })

  it('轮次里没有这一家：这一家仍吃知识，在轮的那家走执行态', () => {
    const rows = [rowOf({ key: 'a' }), rowOf({ key: 'b' })]
    const inventory = invOf({ a: invEntry(), b: invEntry() })
    const session = roundSession(['b'])
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.updatable, 1, 'a 不在轮里，吃知识')
    assert.equal(counts.pending, 1, 'b 在轮里，按旧相位')
  })

  it('会话形状坏 / 没传会话：当无轮次，与旧两参调用一致（零回归）', () => {
    const rows = [rowOf({ key: 'a' })]
    const inventory = invOf({ a: invEntry() })
    for (const bad of [undefined, null, 'x', {}, { entries: null }, { entries: [7, 'x'] }]) {
      const counts = batchLedgerCounts(rows, inventory, bad)
      assert.equal(counts.updatable, 1, '坏形状不放大也不吞知识：' + JSON.stringify(bad))
    }
    assert.equal(batchLedgerCounts(rows, inventory).updatable, 1, '旧两参调用不变')
  })

  it('相位认不出的会话行按 pending 读（与 asBatchPhase 同纪律）', () => {
    const rows = [rowOf({ key: 'a' })]
    const inventory = invOf({ a: invEntry() })
    const session = { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: ['a'], entries: [{ key: 'a', phase: 'weird' }], createdAt: 0, updatedAt: 0 }
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.pending, 1, '认不出的相位按 pending：算在轮里，不吃知识')
    assert.equal(counts.updatable, 0)
  })

  it('混合一行一档：七档之和恒等于行数（含在轮行与坏知识）', () => {
    const rows = [
      rowOf({ key: 'a' }),
      rowOf({ key: 'b', phase: 'installing' }),
      rowOf({ key: 'c', phase: 'failed' }),
      rowOf({ key: 'd' }),
      rowOf({ key: 'e', phase: 'checking' }),
      rowOf({ key: 'f' }),
    ]
    const inventory = invOf({
      a: invEntry(),
      c: invEntry(),
      d: invEntry({ installedVersion: '0.3.46', latestVersion: '0.3.46' }),
      e: invEntry(),
      f: invEntry({ latestVersion: null, error: 'check-failed' }),
    })
    const session = roundSession(['f'])
    const counts = batchLedgerCounts(rows, inventory, session)
    const sum = counts.updatable + counts.installing + counts.pending + counts.restart + counts.failed + counts.skipped + counts.settled
    assert.equal(sum, rows.length, '每行恰好进一档')
    assert.equal(counts.updatable, 1, '只有 a 吃知识进可更新')
    assert.equal(counts.pending, 2, 'e（checking）与 f（在轮）都待查')
    assert.equal(counts.settled, 1, 'd 已最新')
    assert.equal(counts.installing, 1)
    assert.equal(counts.failed, 1, '只有真失败行 c 算失败')
  })

  it('入口徽标与面板同一口径：有轮次未做完时不喊 N 家可更新', () => {
    const rows = [rowOf({ key: 'a' }), rowOf({ key: 'b' })]
    const inventory = invOf({ a: invEntry(), b: invEntry() })
    const session = roundSession(['a', 'b'])
    const inRound = batchEntrySummary({ rows, error: null, inventory, session }, 'zh')
    assert.equal(inRound.updatable, 0, '徽标不吃在轮行的知识')
    assert.equal(inRound.kind, 'idle', '档位回到无事可报（点开是执行态）')
    const panel = batchLedgerText(batchLedgerCounts(rows, inventory, session), 'zh')
    assert.equal(panel, batchLedgerText({ updatable: 0, installing: 0, pending: 2, restart: 0, failed: 0, skipped: 0, settled: 0 }, 'zh'), '徽标与面板同一份数法')
    const noRound = batchEntrySummary({ rows, error: null, inventory }, 'zh')
    assert.equal(noRound.updatable, 2, '无轮次仍吃知识（#83 口径不变）')
    assert.equal(noRound.kind, 'update')
  })
});

describe('#73 集成：挂载路径同一句话（面板 + 入口徽标）', () => {
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

  function fakeContainer() {
    const listeners = []
    return {
      innerHTML: '',
      listeners,
      addEventListener(type, fn) {
        if (type === 'click') listeners.push(fn)
      },
      removeEventListener(type, fn) {
        const at = listeners.indexOf(fn)
        if (at >= 0) listeners.splice(at, 1)
      },
    }
  }

  it('批量面板挂载：回包里的会话进总账，在轮的行不吃知识（同一句话）', async () => {
    const rows = ['a', 'b'].map((k) => rowOf({ key: k, title: k }))
    const inventory = invOf({ a: invEntry(), b: invEntry() })
    const session = roundSession(['a', 'b'])
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life',
      call: async () => ({ ok: true, session, rows, progress: {}, inventory }),
      pollMs: 60000,
      autoResume: false,
      checkOnOpen: false,
    })
    await settled()
    assert.equal(sumTextOf(box.innerHTML), '2 家还没查过；点「检查更新」查一轮。', '挂载路径也走执行态口径')
    assert.equal(ledgerTextOf(box.innerHTML), '2 家待查')
    assert.equal(countOf(box.innerHTML, '有新版 0.3.46'), 0, '在轮行不吃知识')
    panel.unmount()
  })

  it('批量面板挂载：空会话 + 知识，截图场景在真挂载路径上不再矛盾', async () => {
    const rows = seven.map((k) => rowOf({ key: k }))
    const entries = {}
    for (const r of rows) entries[r.key] = invEntry()
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life',
      call: async () => ({ ok: true, session: emptySession(), rows, progress: {}, inventory: invOf(entries) }),
      pollMs: 60000,
      autoResume: false,
      checkOnOpen: false,
    })
    await settled()
    assert.ok(!box.innerHTML.includes('还没查过'), '挂载路径不再报还没查过')
    assert.equal(ledgerTextOf(box.innerHTML), '7 家可更新')
    assert.equal(countOf(box.innerHTML, '有新版 0.3.46'), 7)
    panel.unmount()
  })

  it('批量入口挂载：有轮次未做完时不喊 N 家可更新（点开才是执行态）', async () => {
    const rows = ['a', 'b'].map((k) => rowOf({ key: k, title: k }))
    const inventory = invOf({ a: invEntry(), b: invEntry() })
    const box = fakeContainer()
    const entry = mountUpdateBatchEntry(box, {
      prefix: 'life',
      call: async () => ({ ok: true, session: roundSession(['a', 'b']), rows, progress: {}, inventory }),
      pollMs: 60000,
    })
    await settled()
    assert.ok(box.innerHTML.includes('检查更新'), '徽标按执行态读数 = 无事可报')
    assert.ok(!box.innerHTML.includes('2 家可更新'), '不喊可更新')
    entry.unmount()
    const box2 = fakeContainer()
    const entry2 = mountUpdateBatchEntry(box2, {
      prefix: 'life',
      call: async () => ({ ok: true, session: emptySession(), rows, progress: {}, inventory }),
      pollMs: 60000,
    })
    await settled()
    assert.ok(box2.innerHTML.includes('2 家可更新'), '空会话（无轮次）仍吃知识')
    entry2.unmount()
  })
});
