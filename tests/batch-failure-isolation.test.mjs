/**
 * tests/batch-failure-isolation.test.mjs —— 传输抛错的失败隔离（#276 US6）。
 *
 * 只测外部行为：某一家的查/装抛异常，只把这一家落成 failed(error='unknown', stage=check/install)，
 * 别的家照常推进、整批不被判 failed（不 reject、能跑到 finished）；stopOnFailure 仍然按策略停；
 * 失败之后成功的那一家在 done 时清掉旧 error。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { batchEntryOf, createBatchSession } from '../dist/core/batch/model.js'
import { runBatch } from '../dist/core/batch/run.js'

function session(overrides = {}) {
  return createBatchSession({ id: 'b1', keys: ['alpha', 'beta'], now: 1000, ...overrides })
}

/** 假件：查/装按表出结果或抛异常；记录每一次调用、落盘与失败日志行。 */
function fakeDeps(plan = {}) {
  const calls = { check: [], install: [], saved: [] }
  const logRows = []
  let clock = 2000
  return {
    calls,
    logRows,
    deps: {
      check: async (key) => {
        calls.check.push(key)
        const p = plan[key] ?? { kind: 'update', version: '2.0.0' }
        if (p.check === 'throw') throw new Error('boom /Users/someone/secret/path')
        return p.check ?? p
      },
      install: async (key, requestId, version) => {
        calls.install.push({ key, requestId, version })
        const p = plan[key] ?? { kind: 'update', version: '2.0.0' }
        if (p.install === 'throw') throw new Error('boom /Users/someone/secret/path')
        return p.install ?? { kind: 'done', restartRequired: false }
      },
      save: (s) => {
        calls.saved.push(JSON.parse(JSON.stringify(s)))
      },
      now: () => (clock += 10),
      logFor: (key) => (level, event, fields) => {
        logRows.push({ key, level, event, fields })
      },
    },
  }
}

function failedRows(s) {
  return s.entries.filter((e) => e.phase === 'failed').map((e) => e.key)
}

describe('查抛异常：只影响这一行（US6 失败隔离）', () => {
  it('该行落 failed(error=unknown)，其余照常装完、整批跑到 finished', async () => {
    const { deps, calls } = fakeDeps({ alpha: { check: 'throw' } })
    const r = await runBatch(session(), deps)

    const alpha = batchEntryOf(r.session, 'alpha')
    assert.equal(alpha.phase, 'failed', '抛错的那家按失败落盘')
    assert.equal(alpha.error, 'unknown', '异常原话（可能带路径）不得进账本')
    assert.deepEqual(calls.check, ['alpha', 'beta'], '默认策略：继续下一家')
    assert.deepEqual(calls.install.map((i) => i.key), ['beta'], '别家照常装')
    assert.equal(batchEntryOf(r.session, 'beta').phase, 'done')
    assert.equal(r.stoppedBecause, 'finished', '整批照常收尾，不被判 failed')
    assert.deepEqual(r.steps[0], { key: 'alpha', action: 'check', phase: 'failed', error: 'unknown' })
    assert.deepEqual(calls.saved[calls.saved.length - 1], JSON.parse(JSON.stringify(r.session)), '失败也落了盘')
  })

  it('失败日志行 stage=check、errorKind=unknown（异常 message 不外泄）', async () => {
    const { deps, logRows } = fakeDeps({ alpha: { check: 'throw' } })
    await runBatch(session(), deps)
    const row = logRows.find((x) => x.key === 'alpha' && x.event === 'update.batch.entry.fail')
    assert.ok(row, '失败必须记一行')
    assert.equal(row.fields.stage, 'check')
    assert.equal(row.fields.errorKind, 'unknown')
    assert.equal(row.fields.index, 0)
    assert.equal(JSON.stringify(row.fields).includes('secret'), false, '日志里不许出现异常原话')
  })

  it('stopOnFailure：查抛异常同样按策略停下，后面的不碰', async () => {
    const { deps, calls } = fakeDeps({ alpha: { check: 'throw' } })
    const r = await runBatch(session({ stopOnFailure: true }), deps)
    assert.equal(r.stoppedBecause, 'stopped-after-failure')
    assert.deepEqual(calls.check, ['alpha'])
    assert.equal(batchEntryOf(r.session, 'beta').phase, 'pending')
  })
})

describe('装抛异常：只影响这一行（US6 失败隔离）', () => {
  it('该行落 failed(error=unknown)，下一家继续装、整批跑到 finished', async () => {
    const { deps, calls } = fakeDeps({ alpha: { install: 'throw' } })
    const r = await runBatch(session(), deps)

    const alpha = batchEntryOf(r.session, 'alpha')
    assert.equal(alpha.phase, 'failed')
    assert.equal(alpha.error, 'unknown')
    assert.deepEqual(calls.install.map((i) => i.key), ['alpha', 'beta'], '继续推下一家')
    assert.equal(batchEntryOf(r.session, 'beta').phase, 'done')
    assert.equal(r.stoppedBecause, 'finished')
    assert.deepEqual(
      r.steps.find((s) => s.key === 'alpha' && s.action === 'install'),
      { key: 'alpha', action: 'install', phase: 'failed', error: 'unknown' },
    )
  })

  it('失败日志行 stage=install、errorKind=unknown', async () => {
    const { deps, logRows } = fakeDeps({ alpha: { install: 'throw' } })
    await runBatch(session(), deps)
    const row = logRows.find((x) => x.key === 'alpha' && x.event === 'update.batch.entry.fail')
    assert.ok(row)
    assert.equal(row.fields.stage, 'install')
    assert.equal(row.fields.errorKind, 'unknown')
  })

  it('stopOnFailure：装抛异常同样按策略停下', async () => {
    const { deps, calls } = fakeDeps({ alpha: { install: 'throw' } })
    const r = await runBatch(session({ stopOnFailure: true }), deps)
    assert.equal(r.stoppedBecause, 'stopped-after-failure')
    assert.deepEqual(calls.install.map((i) => i.key), ['alpha'])
    assert.equal(batchEntryOf(r.session, 'beta').phase, 'pending')
  })
})

describe('失败之后成功：done 落盘时清掉旧 error', () => {
  it('上一轮留下的 error 不跟着 done 行进账本', async () => {
    const base = session()
    const stale = {
      ...base,
      entries: base.entries.map((e) => (e.key === 'alpha' ? { ...e, phase: 'ready', targetVersion: '2.0.0', error: 'install-failed' } : e)),
    }
    const { deps } = fakeDeps()
    const r = await runBatch(stale, deps)
    const alpha = batchEntryOf(r.session, 'alpha')
    assert.equal(alpha.phase, 'done')
    assert.equal(alpha.error, null, '成功行不许带着上一轮的失败码')
  })
})
