/**
 * tests/batch.test.mjs —— 多目标批量更新的会话账本（#25）。
 *
 * 只测外部行为/纯函数：排序（自更新安全）、幂等编号、断点续跑、进度读数、
 * 坏账本回退不抛错。落盘与读写不在这里测（那是宿主侧的事）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BATCH_SESSION_VERSION,
  batchEntryOf,
  batchProgress,
  batchRequestId,
  createBatchSession,
  emptyBatchSession,
  failedKeys,
  isBatchFinished,
  isTerminalPhase,
  markBatchEntry,
  needsRestartKeys,
  nextBatchKey,
  normalizeBatchSession,
  orderTargets,
  resumeBatchSession,
} from '../dist/batch.js'

const KEYS = ['alpha', 'beta', 'self', 'gamma']

function session(overrides = {}) {
  return createBatchSession({ id: 'b1', keys: KEYS, selfKey: 'self', now: 1000, ...overrides })
}

function phaseOf(s, key) {
  const entry = batchEntryOf(s, key)
  return entry ? entry.phase : null
}

describe('排序：自己排最后（自更新安全）', () => {
  it('selfKey 排到最后，其余保持传入顺序', () => {
    assert.deepEqual(orderTargets(KEYS, 'self'), ['alpha', 'beta', 'gamma', 'self'])
  })

  it('selfKey 不在表里就按原序，不凭空造一个', () => {
    assert.deepEqual(orderTargets(KEYS, 'nope'), KEYS)
    assert.deepEqual(orderTargets(KEYS, null), KEYS)
  })

  it('重复键去重且保序（键乱序会让顺序漂移）', () => {
    assert.deepEqual(orderTargets(['b', 'a', 'b', 'a', 'c'], null), ['b', 'a', 'c'])
    assert.deepEqual(orderTargets(['b', 'self', 'a', 'self'], 'self'), ['b', 'a', 'self'])
  })

  it('空表与非法键不抛错', () => {
    assert.deepEqual(orderTargets([], 'self'), [])
    assert.deepEqual(orderTargets(['', 'a', null, undefined], null), ['a'])
  })

  it('会话按这个顺序建表：最后一行是自己', () => {
    const s = session()
    assert.deepEqual(s.order, ['alpha', 'beta', 'gamma', 'self'])
    assert.equal(s.entries[s.entries.length - 1].key, 'self')
    assert.equal(s.selfKey, 'self')
    assert.equal(s.version, BATCH_SESSION_VERSION)
  })
})

describe('幂等编号：同一会话同一目标恒定', () => {
  it('同键恒定、异键不同、异会话不同', () => {
    assert.equal(batchRequestId('b1', 'alpha'), 'batch:b1:alpha')
    assert.equal(batchRequestId('b1', 'alpha'), batchRequestId('b1', 'alpha'))
    assert.notEqual(batchRequestId('b1', 'alpha'), batchRequestId('b1', 'beta'))
    assert.notEqual(batchRequestId('b1', 'alpha'), batchRequestId('b2', 'alpha'))
  })

  it('编号写进每一行，且不许被 patch 改掉（改了就不幂等了）', () => {
    const s = session()
    const first = batchEntryOf(s, 'alpha').requestId
    const { session: next } = markBatchEntry(s, 'alpha', { phase: 'ready', requestId: 'x' }, 2000)
    assert.equal(batchEntryOf(next, 'alpha').requestId, first, '幂等编号不许被覆盖')
  })
})

describe('推进顺序：按会话顺序取下一个非终态', () => {
  it('初始下一个是第一行；收尾一行就往后走', () => {
    let s = session()
    assert.equal(nextBatchKey(s), 'alpha')
    s = markBatchEntry(s, 'alpha', { phase: 'done' }, 1500).session
    assert.equal(nextBatchKey(s), 'beta')
  })

  it('失败也算收尾：默认继续下一家', () => {
    let s = session()
    s = markBatchEntry(s, 'alpha', { phase: 'failed', error: 'install-failed' }, 1500).session
    assert.equal(s.stopOnFailure, false)
    assert.equal(nextBatchKey(s), 'beta', '默认策略：一家失败继续下一家')
  })

  it('stopOnFailure 时一遇失败就停', () => {
    let s = session({ stopOnFailure: true })
    assert.equal(nextBatchKey(s), 'alpha')
    s = markBatchEntry(s, 'alpha', { phase: 'failed', error: 'install-failed' }, 1500).session
    assert.equal(nextBatchKey(s), null, '要求遇错即停就该停')
  })

  it('全部进终态就返回 null', () => {
    let s = session()
    for (const key of s.order) s = markBatchEntry(s, key, { phase: 'done' }, 1500).session
    assert.equal(nextBatchKey(s), null)
    assert.equal(isBatchFinished(s), true)
  })

  it('空会话不算「已结束」（没活可干 ≠ 干完了）', () => {
    assert.equal(isBatchFinished(emptyBatchSession()), false)
    assert.equal(nextBatchKey(emptyBatchSession()), null)
  })
})

describe('改一行：不可变、键不存在不报错', () => {
  it('返回新会话，原会话不动', () => {
    const s = session()
    const { session: next, changed } = markBatchEntry(s, 'beta', { phase: 'installing' }, 2000)
    assert.equal(changed, true)
    assert.equal(phaseOf(s, 'beta'), 'pending', '原会话不许被改')
    assert.equal(phaseOf(next, 'beta'), 'installing')
    assert.equal(next.updatedAt, 2000)
  })

  it('键不存在时原样返回', () => {
    const s = session()
    const { session: next, changed } = markBatchEntry(s, 'nope', { phase: 'done' }, 2000)
    assert.equal(changed, false)
    assert.equal(next, s)
  })

  it('改一行不影响别行的相位（各行自显）', () => {
    let s = session()
    s = markBatchEntry(s, 'alpha', { phase: 'installing' }, 2000).session
    assert.equal(phaseOf(s, 'beta'), 'pending')
    assert.equal(phaseOf(s, 'self'), 'pending')
  })
})

describe('断点续跑：进行中的退回 pending，已完成的不重装', () => {
  it('checking / installing 退回 pending，终态保留', () => {
    let s = session()
    s = markBatchEntry(s, 'alpha', { phase: 'done', restartRequired: true }, 2000).session
    s = markBatchEntry(s, 'beta', { phase: 'failed', error: 'install-failed' }, 2100).session
    s = markBatchEntry(s, 'gamma', { phase: 'installing' }, 2200).session
    s = markBatchEntry(s, 'self', { phase: 'checking' }, 2300).session
    const resumed = resumeBatchSession(s, 3000)
    assert.equal(phaseOf(resumed, 'alpha'), 'done', '已完成的不许重装')
    assert.equal(phaseOf(resumed, 'beta'), 'failed', '失败记录要留着给人看')
    assert.equal(phaseOf(resumed, 'gamma'), 'pending', '装到一半的退回重查')
    assert.equal(phaseOf(resumed, 'self'), 'pending', '查到一半的退回重查')
    assert.equal(nextBatchKey(resumed), 'gamma', '续跑从没做完的那家接着走')
    assert.equal(resumed.updatedAt, 3000)
  })

  it('ready 不退回（那一家的查询结果还有效，重查是可选的）', () => {
    const s = markBatchEntry(session(), 'alpha', { phase: 'ready', targetVersion: '1.2.0' }, 2000).session
    const resumed = resumeBatchSession(s, 3000)
    assert.equal(phaseOf(resumed, 'alpha'), 'ready')
    assert.equal(batchEntryOf(resumed, 'alpha').targetVersion, '1.2.0')
  })

  it('没有进行中的行时原样返回（省一次落盘）', () => {
    const s = markBatchEntry(session(), 'alpha', { phase: 'done' }, 2000).session
    assert.equal(resumeBatchSession(s, 3000), s)
  })
})

describe('进度与总账', () => {
  it('读数逐项对齐', () => {
    let s = session()
    s = markBatchEntry(s, 'alpha', { phase: 'done', restartRequired: true }, 2000).session
    s = markBatchEntry(s, 'beta', { phase: 'failed', error: 'install-failed' }, 2100).session
    s = markBatchEntry(s, 'gamma', { phase: 'skipped' }, 2200).session
    const p = batchProgress(s)
    assert.equal(p.total, 4)
    assert.equal(p.done, 1)
    assert.equal(p.failed, 1)
    assert.equal(p.skipped, 1)
    assert.equal(p.pending, 1, '自己那行还没动')
    assert.equal(p.finished, false)
    s = markBatchEntry(s, 'self', { phase: 'done' }, 2300).session
    assert.equal(batchProgress(s).finished, true)
  })

  it('current 把查/装/待装三态都算进去（面板显示「正在处理」用）', () => {
    let s = session()
    s = markBatchEntry(s, 'alpha', { phase: 'checking' }, 1).session
    s = markBatchEntry(s, 'beta', { phase: 'ready' }, 1).session
    s = markBatchEntry(s, 'gamma', { phase: 'installing' }, 1).session
    assert.equal(batchProgress(s).current, 3)
  })

  it('「已是最新」算 done（不需要动的那家不该挂着）', () => {
    const s = markBatchEntry(session(), 'alpha', { phase: 'current' }, 1).session
    assert.equal(batchProgress(s).done, 1)
    assert.equal(isTerminalPhase('current'), true)
  })

  it('要重启的那几家与失败的那几家各自成表', () => {
    let s = session()
    s = markBatchEntry(s, 'alpha', { phase: 'done', restartRequired: true }, 1).session
    s = markBatchEntry(s, 'self', { phase: 'done', restartRequired: true }, 1).session
    s = markBatchEntry(s, 'beta', { phase: 'failed', error: 'update-busy' }, 1).session
    assert.deepEqual(needsRestartKeys(s), ['alpha', 'self'])
    assert.deepEqual(failedKeys(s), ['beta'])
  })
})

describe('坏账本回退：不抛错、不挡更新', () => {
  it('版本不对 / 形状不对 / 空值一律回空会话', () => {
    for (const bad of [null, undefined, 0, 'x', [], {}, { version: 2, id: 'b' }, { version: 1, entries: 'nope' }]) {
      const s = normalizeBatchSession(bad)
      assert.equal(s.entries.length, 0, JSON.stringify(bad) + ' 应回空会话')
      assert.equal(s.version, 1)
    }
  })

  it('好账本原样读回：顺序与编号都在', () => {
    const s = session()
    const back = normalizeBatchSession(JSON.parse(JSON.stringify(s)))
    assert.deepEqual(back.order, s.order)
    assert.deepEqual(back.entries.map((e) => e.requestId), s.entries.map((e) => e.requestId))
    assert.equal(back.selfKey, 'self')
  })

  it('order 以 entries 为准（两处不同步时以行表为准，不自相矛盾）', () => {
    const raw = {
      version: 1,
      id: 'b1',
      selfKey: 'ghost',
      order: ['ghost', 'alpha', 'alpha'],
      entries: [
        { key: 'alpha', phase: 'pending', requestId: 'r1', targetVersion: null, restartRequired: false, error: null, updatedAt: 1 },
      ],
      createdAt: 1,
      updatedAt: 1,
    }
    const s = normalizeBatchSession(raw)
    assert.deepEqual(s.order, ['alpha'], 'order 由 entries 重建')
    assert.equal(s.selfKey, null, 'selfKey 不在行表里就不认')
  })

  it('坏相位落回 pending，坏编号按会话重算', () => {
    const raw = {
      version: 1,
      id: 'b9',
      order: ['a'],
      entries: [{ key: 'a', phase: 'wat', requestId: '', targetVersion: 7, restartRequired: 'yes', error: 3, updatedAt: -5 }],
    }
    const s = normalizeBatchSession(raw)
    assert.equal(s.entries[0].phase, 'pending')
    assert.equal(s.entries[0].requestId, batchRequestId('b9', 'a'))
    assert.equal(s.entries[0].targetVersion, null)
    assert.equal(s.entries[0].restartRequired, false)
    assert.equal(s.entries[0].error, null)
  })
})
