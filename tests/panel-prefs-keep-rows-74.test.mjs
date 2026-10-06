import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdateBatchPanel } from '../dist/panel-batch.js'

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

function rowOf(overrides = {}) {
  return {
    key: 'a',
    title: '\u7532\u63d2\u4ef6',
    phase: 'ready',
    targetVersion: '1.2.0',
    restartRequired: false,
    error: null,
    snapshot: null,
    manual: null,
    queue: null,
    profileName: null,
    ...overrides,
  }
}

function sessionOf(rows) {
  return {
    version: 1,
    id: 's1',
    selfKey: null,
    stopOnFailure: false,
    order: rows.map((r) => r.key),
    entries: rows.map((r) => ({
      key: r.key,
      phase: r.phase,
      requestId: 'batch:s1:' + r.key,
      targetVersion: r.targetVersion,
      restartRequired: r.restartRequired,
      error: r.error,
      updatedAt: 1,
    })),
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('issue 74: prefs-only save keeps rows', () => {
  it('toggle with prefs-only reply does not flash empty', async () => {
    const rows = [rowOf({ key: 'a', title: '\u7532\u63d2\u4ef6' }), rowOf({ key: 'b', title: '\u4e59\u63d2\u4ef6' })]
    const box = fakeContainer()
    const call = async (name, args) => {
      if (name.endsWith('.batchStatus')) {
        return { ok: true, session: sessionOf(rows), rows, progress: {}, prefs: { checkOnOpen: true } }
      }
      if (name.endsWith('.batchPrefsSave')) {
        // Real host shape: prefs only, no session/rows/inventory.
        return { ok: true, prefs: { checkOnOpen: args.checkOnOpen } }
      }
      return { ok: true, session: sessionOf(rows), rows, progress: {}, prefs: { checkOnOpen: true } }
    }
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false })
    await settled()
    await settled()
    const before = box.innerHTML
    assert.ok(before.includes('\u7532\u63d2\u4ef6') && before.includes('\u4e59\u63d2\u4ef6'), 'toggle前两行都在')
    assert.equal((before.match(/class="dsh-upd-brow"/g) || []).length, 2)
    await panel.act('toggle-check-on-open')
    await settled()
    const after = box.innerHTML
    assert.equal((after.match(/class="dsh-upd-brow"/g) || []).length, 2, 'prefs-only 保存后仍是两行，不闪空')
    assert.ok(after.includes('\u7532\u63d2\u4ef6') && after.includes('\u4e59\u63d2\u4ef6'), '两行标题都在')
    assert.ok(after.includes('[ ]'), '开关翻到未勾选')
    panel.unmount()
  })

  it('failed prefs save keeps rows', async () => {
    const rows = [rowOf({ key: 'a', title: '\u7532\u63d2\u4ef6' })]
    const box = fakeContainer()
    const call = async (name) => {
      if (name.endsWith('.batchStatus')) {
        return { ok: true, session: sessionOf(rows), rows, progress: {}, prefs: { checkOnOpen: true } }
      }
      if (name.endsWith('.batchPrefsSave')) {
        return { ok: false, error: 'check-failed', errorKind: 'check-failed' }
      }
      return { ok: true, session: sessionOf(rows), rows, progress: {} }
    }
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false })
    await settled()
    await settled()
    await panel.act('toggle-check-on-open')
    await settled()
    const after = box.innerHTML
    assert.equal((after.match(/class="dsh-upd-brow"/g) || []).length, 1, '失败也不清空行')
    panel.unmount()
  })
})
