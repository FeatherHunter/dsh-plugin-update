/**
 * tests/issue-90-world-ledger.test.mjs —— #90 世界账与轮次账分家 + 检查诚实语义 + 轮询放行。
 *
 * 只测外部行为（Agent Brief 验收 1–4 条；第 5 条由全量门禁覆盖）：
 *  1. 终态全 current 会话 + 更新鲜可更新知识 → 总账不再「全部已最新」，行显示新版可更新；
 *  2. 单家查新版在快照无 latestVersion 时永不显示「已是最新」（defensive 分支，只达快照层，见注）；
 *  3. 全部更新驱动多家时，收尾前即可观测中间进度（轮询不再被在途抑制）；
 *  4. 驱动进行中调检查电话：明确回忙，不用旧表冒充 fresh 结果。
 *
 * 注：宿主 defaultCheck 的「无 latest → check-failed」分支经公开 seam 不可达
 * （真核心 check 成功必带 release；失败走 ok:false），故此处不造假件硬够，
 * 由代码注释 + 本文件 B 组「失败检查不推翻旧结论」侧写覆盖。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  batchLedgerCounts,
  batchRowKnowledgeText,
  mountUpdateBatchPanel,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { createBatchSession } from '../dist/batch.js'
import { batchPathsForOwner } from '../dist/store.js'
import { beforeEach } from 'node:test'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

function rowOf(o = {}) {
  return { key: 'a', title: '甲', phase: 'pending', targetVersion: null, restartRequired: false, error: null, snapshot: null, manual: null, queue: null, profileName: null, ...o }
}
function snap(installed) {
  return { installedVersion: installed, runningVersion: installed }
}
/** 已收尾会话：entries 全终态，各带 updatedAt（新鲜度裁决用）。 */
function finishedSession(keys, at = 1000, phase = 'current') {
  return {
    version: 1, id: 's', selfKey: null, stopOnFailure: false, order: keys,
    entries: keys.map((key) => ({ key, phase, requestId: 'batch:s:' + key, targetVersion: null, restartRequired: false, error: null, updatedAt: at })),
    createdAt: at, updatedAt: at,
  }
}
function invEntry(o = {}) {
  return { lastCheckedAt: 2000, installedVersion: '0.3.49', latestVersion: '0.3.50', canInstall: true, error: null, ...o }
}
function invOf(entries, at = 2000) {
  return { version: 1, updatedAt: at, entries }
}
function countOf(html, word) {
  return html.split(word).length - 1
}
function sumTextOf(html) {
  const m = html.match(/<div class="dsh-upd-batch-sum"[^>]*>([\s\S]*?)<\/div>/)
  return m ? m[1] : ''
}
function ledgerTextOf(html) {
  const m = html.match(/<div class="dsh-upd-batch-ledger">([\s\S]*?)<\/div>/)
  return m ? m[1] : ''
}
function fakeContainer() {
  const listeners = []
  return {
    innerHTML: '',
    addEventListener(type, fn) { listeners.push(fn) },
    removeEventListener(type, fn) {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
}
async function settle() {
  await new Promise((done) => setImmediate(done))
  await new Promise((done) => setImmediate(done))
}

describe('#90 A：终态会话不再遮挡新知识（世界账推翻）', () => {
  it('全 current 收尾 + 更新鲜可更新知识：总账 updatable，不再全部已最新', () => {
    const rows = ['a', 'b'].map((k) => rowOf({ key: k, phase: 'current', snapshot: snap('0.3.49') }))
    const entries = {}
    for (const r of rows) entries[r.key] = invEntry()
    const inventory = invOf(entries)
    const session = finishedSession(['a', 'b'], 1000)
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.updatable, 2)
    assert.equal(counts.settled, 0)
    const html = renderBatchPanelHTML({ rows, session, inventory, lang: 'zh' })
    assert.ok(!sumTextOf(html).includes('全部已最新'), '顶部不再报全部已最新')
    assert.ok(sumTextOf(html).includes('2 家可更新'), '顶部报可更新')
    assert.equal(countOf(html, '有新版 0.3.50'), 2, '行状态词与新知识一致')
    assert.equal(ledgerTextOf(html), '2 家可更新', '底部总账同步')
    assert.equal(countOf(html, '<span class="dsh-upd-updot" data-tone="todo"'), 2, '圆点与可更新同色（ready 口径；样式块不计入）')
  })

  it('陈旧知识不推翻：lastCheckedAt <= 会话行 updatedAt 即沿旧结论', () => {
    const rows = [rowOf({ key: 'a', phase: 'current', snapshot: snap('0.3.49') })]
    const inventory = invOf({ a: invEntry({ lastCheckedAt: 500 }) })
    const session = finishedSession(['a'], 1000)
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.settled, 1, '装完后落盘的旧知识不把 done/current 翻成可更新')
    assert.equal(counts.updatable, 0)
  })

  it('失败的检查不推翻：error 知识保留旧结论', () => {
    const rows = [rowOf({ key: 'a', phase: 'current', snapshot: snap('0.3.49') })]
    const inventory = invOf({ a: invEntry({ error: 'check-failed' }) })
    const session = finishedSession(['a'], 1000)
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.settled, 1)
    assert.equal(counts.updatable, 0)
    assert.equal(counts.failed, 0, '知识查失败不冒充安装失败')
  })

  it('done + 待重启行不推翻：重启终态优先', () => {
    const rows = [rowOf({ key: 'a', phase: 'done', restartRequired: true, snapshot: snap('0.3.50') })]
    const inventory = invOf({ a: invEntry() })
    const session = finishedSession(['a'], 1000, 'done')
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.restart, 1)
    assert.equal(counts.updatable, 0)
  })

  it('done 无重启 + 新知识：同样推翻为可更新', () => {
    const rows = [rowOf({ key: 'a', phase: 'done', snapshot: snap('0.3.49') })]
    const inventory = invOf({ a: invEntry() })
    const session = finishedSession(['a'], 1000, 'done')
    const counts = batchLedgerCounts(rows, inventory, session)
    assert.equal(counts.updatable, 1)
  })

  it('R5：查过但无版本不再报已是最新，回还没查过', () => {
    const row = rowOf({ phase: 'pending' })
    assert.equal(
      batchRowKnowledgeText(row, { lastCheckedAt: 2000, installedVersion: null, latestVersion: null, canInstall: null, error: null }, 'zh'),
      '还没查过',
    )
    const counts = batchLedgerCounts([row], invOf({ a: { lastCheckedAt: 2000, installedVersion: null, latestVersion: null, canInstall: null, error: null } }))
    assert.equal(counts.pending, 1)
    assert.equal(counts.settled, 0)
  })
})

describe('#90 B：驱动进行中调检查电话明确回忙', () => {
  async function tempScope() {
    const dir = await mkdtemp(join(tmpdir(), 'issue-90-'))
    return { dir, scope: { homeDir: dir, profileDir: dir } }
  }
  function target(key) {
    return { key, title: '插件 ' + key, packageName: 'pkg-' + key, prefix: 'p-' + key }
  }

  it('batchCheck 在驱动中回 ok:false update-busy；驱动本身不受影响', async () => {
    const { scope } = await tempScope()
    let busyReply = null
    const transport = {
      check: async (key) => ({ kind: 'update', version: '2.0.0' }),
      install: async (key, spec, requestId, version) => {
        if (key === 'a' && busyReply === null) {
          busyReply = await host.handlers['life.batchCheck']({})
        }
        return { kind: 'done', restartRequired: false }
      },
    }
    const host = createMultiHostUpdate({ scope, transport }, { prefix: 'life', targets: [target('a'), target('b')] })
    const reply = await host.handlers['life.batchInstall']({})
    assert.ok(busyReply, '驱动中那次检查回来了')
    assert.equal(busyReply.ok, false, '检查在驱动中不冒充 fresh 结果')
    assert.equal(busyReply.error, 'update-busy')
    assert.equal(busyReply.errorKind, 'update-busy')
    assert.equal(reply.ok, true, '驱动本身照常收尾')
    assert.equal(reply.progress.finished, true)
    host.dispose()
  })
})

describe('#90 C：装类在途不抑制轮询（渐进可见），查类在途仍让路（#87）', () => {
  it('act(install) 在途时计时器刷新仍打 batchStatus', async () => {
    const seen = []
    let releaseInstall = null
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life',
      call: async (name) => {
        seen.push(name)
        if (name === 'life.batchInstall') await new Promise((done) => { releaseInstall = done })
        return { ok: true, session: { version: 1, id: '', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 }, rows: [], progress: {}, inventory: { version: 1, updatedAt: 0, entries: {} } }
      },
      pollMs: 250,
      autoResume: false,
      checkOnOpen: false,
    })
    await settle()
    const before = seen.filter((n) => n === 'life.batchStatus').length
    const acting = panel.act('install')
    await new Promise((done) => setTimeout(done, 700))
    const during = seen.filter((n) => n === 'life.batchStatus').length
    assert.ok(during > before, '装类在途轮询仍刷新（前 ' + before + ' 次，途中 ' + during + ' 次）')
    releaseInstall()
    await acting
    panel.unmount()
  })
})
