/**
 * tests/issue-85-contract.test.mjs —— #85 续跑/取消/关闭契约 AFK 部分。
 *
 * 只测外部行为：stalled 判据必须要求盘上有会话（#82 已定 ledger/行相位不可作判据，
 * hasUnfinishedRows 文档承诺的也是「盘上有没做完的一轮」）；无会话假成功不再出现；
 * unmount 只停轮询；关闭不等于取消。
 *
 * 文案终裁归人类（grilling+task）：判据与回执行为见下；Q3 定的继续按钮悬停
 *（batch.action.resume-title）随本单新增一键，不改电话形状。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasUnfinishedRows,
  mountUpdateBatchPanel,
  renderBatchPanelHTML,
  unfinishedCount,
} from '../dist/panel-batch.js'

function rowOf(overrides = {}) {
  return {
    key: 'a', title: '甲插件', phase: 'pending', targetVersion: null, restartRequired: false,
    error: null, snapshot: null, manual: null, queue: null, profileName: null, ...overrides,
  }
}

function sessionOf(entries) {
  return {
    version: 1, id: 's1', selfKey: null, stopOnFailure: false,
    order: entries.map((e) => e.key),
    entries: entries.map((e) => ({
      key: e.key, phase: e.phase, requestId: 'batch:s1:' + e.key,
      targetVersion: e.targetVersion ?? null, restartRequired: false, error: null, updatedAt: 1,
    })),
    createdAt: 1, updatedAt: 1,
  }
}

function fakeContainer() {
  return {
    innerHTML: '',
    addEventListener() {},
    removeEventListener() {},
  }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('#85 stalled 判据：必须要求盘上有会话', () => {
  it('行没做完但盘上没会话（无 session）→ 不算 stalled', () => {
    const rows = [rowOf({ key: 'a', phase: 'pending' }), rowOf({ key: 'b', phase: 'ready', targetVersion: '2.0.0' })]
    assert.equal(hasUnfinishedRows(rows), false)
    assert.equal(hasUnfinishedRows(rows, null), false)
    assert.equal(hasUnfinishedRows(rows, undefined), false)
  })

  it('行没做完但会话是空账本 → 不算 stalled', () => {
    const rows = [rowOf({ key: 'a', phase: 'pending' })]
    assert.equal(hasUnfinishedRows(rows, { entries: [] }), false)
  })

  it('盘上有没做完的一轮 → 算 stalled（正向不断）', () => {
    const rows = [rowOf({ key: 'a', phase: 'done' }), rowOf({ key: 'b', phase: 'pending' })]
    const session = sessionOf([
      { key: 'a', phase: 'done' },
      { key: 'b', phase: 'pending' },
    ])
    assert.equal(hasUnfinishedRows(rows, session), true)
    assert.equal(unfinishedCount(rows, session), 1)
  })

  it('计数同样要求盘上会话：无会话 → 0', () => {
    const rows = [rowOf({ key: 'a', phase: 'pending' }), rowOf({ key: 'b', phase: 'ready', targetVersion: '2.0.0' })]
    assert.equal(unfinishedCount(rows), 0)
    assert.equal(unfinishedCount(rows, null), 0)
    assert.equal(unfinishedCount(rows, { entries: [] }), 0)
  })

  it('纯渲染：行没做完但无会话 → 不画续跑/取消', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'pending' })], lang: 'zh' })
    assert.ok(!html.includes('data-act="resume"'), '无会话不许给续跑，实到：' + html.slice(0, 300))
    assert.ok(!html.includes('data-act="cancel"'), '无会话不许给取消')
  })

  it('纯渲染：盘上有没做完的一轮 → 画续跑/取消 + 常驻生命周期事实', () => {
    const session = sessionOf([
      { key: 'a', phase: 'done' },
      { key: 'b', phase: 'pending' },
    ])
    const html = renderBatchPanelHTML({
      rows: [rowOf({ key: 'a', phase: 'done' }), rowOf({ key: 'b', phase: 'pending' })],
      session, lang: 'zh',
    })
    assert.ok(html.includes('data-act="resume"'), '有继续')
    assert.ok(html.includes('还剩 1 家'), '带计数')
    assert.ok(html.includes('data-act="cancel"'), '有丢弃')
    assert.ok(html.includes('关掉面板不会中断'), '带生命周期事实')
  })

  it('挂载流：宿主回包无 session（只有行）→ 刷新后仍不画续跑/取消', async () => {
    const rows = [rowOf({ key: 'a', phase: 'pending' }), rowOf({ key: 'b', phase: 'ready', targetVersion: '2.0.0' })]
    const box = fakeContainer()
    const call = async () => ({ ok: true, rows, progress: {}, inventory: { version: 1, updatedAt: 0, entries: {} }, prefs: {} })
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false })
    await settled()
    await panel.refresh()
    await settled()
    assert.ok(!box.innerHTML.includes('data-act="resume"'), '无会话挂载流也不许给续跑')
    assert.ok(!box.innerHTML.includes('data-act="cancel"'), '无会话挂载流也不许给取消')
    panel.unmount()
  })
})

describe('#85 无会话假成功不再出现（resumed 事实）', () => {
  it("resume 回 resumed:false → 说「没有可继续的内容」，不报已继续", async () => {
    const rows = [rowOf({ key: 'a', phase: 'done' }), rowOf({ key: 'b', phase: 'pending' })]
    const session = sessionOf([
      { key: 'a', phase: 'done' },
      { key: 'b', phase: 'pending' },
    ])
    const box = fakeContainer()
    const call = async (name) => {
      if (name.endsWith('.batchResume')) {
        return { ok: true, session, rows, progress: {}, inventory: { version: 1, updatedAt: 0, entries: {} }, prefs: {}, resumed: false }
      }
      return { ok: true, session, rows, progress: {}, inventory: { version: 1, updatedAt: 0, entries: {} }, prefs: {} }
    }
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false })
    await settled()
    await panel.act('resume')
    assert.ok(box.innerHTML.includes('没有可继续的内容'), '如实说无事可续，实到：' + box.innerHTML.slice(-300))
    assert.ok(!box.innerHTML.includes('已继续上次'), '不许报空话成功')
    panel.unmount()
  })

  it('继续按钮带悬停：后果说明与丢弃侧对称', () => {
    const session = sessionOf([
      { key: 'a', phase: 'done' },
      { key: 'b', phase: 'pending' },
    ])
    const html = renderBatchPanelHTML({
      rows: [rowOf({ key: 'a', phase: 'done' }), rowOf({ key: 'b', phase: 'pending' })],
      session, lang: 'zh',
    })
    assert.ok(html.includes('data-act="resume" title="从上次没做完的地方接着安装，已完成的不重装"'), '继续按钮须有后果悬停，实到：' + html.slice(html.indexOf('data-act="resume"') - 20, html.indexOf('data-act="resume"') + 200))
    const en = renderBatchPanelHTML({
      rows: [rowOf({ key: 'a', phase: 'done' }), rowOf({ key: 'b', phase: 'pending' })],
      session, lang: 'en',
    })
    assert.ok(en.includes('Continue from where it stopped; installed ones stay'), '英文悬停同在')
  })

  it('resume 回 resumed:true → 报已继续（正向不断）', async () => {
    const rows = [rowOf({ key: 'a', phase: 'done' }), rowOf({ key: 'b', phase: 'pending' })]
    const session = sessionOf([
      { key: 'a', phase: 'done' },
      { key: 'b', phase: 'pending' },
    ])
    const box = fakeContainer()
    const call = async (name) => {
      if (name.endsWith('.batchResume')) {
        return { ok: true, session, rows, progress: {}, inventory: { version: 1, updatedAt: 0, entries: {} }, prefs: {}, resumed: true }
      }
      return { ok: true, session, rows, progress: {}, inventory: { version: 1, updatedAt: 0, entries: {} }, prefs: {} }
    }
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false })
    await settled()
    await panel.act('resume')
    assert.ok(box.innerHTML.includes('已继续上次'), '真续跑要给回执')
    panel.unmount()
  })
})
