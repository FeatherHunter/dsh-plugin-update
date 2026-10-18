/**
 * tests/batch-session.test.mjs —— issue #208：一批必须能被「串起来」。
 *
 * 黑盒视角回答一个问题：跨电话、跨重启，用户还能不能认出「这是同一批」？
 * 三条批量级行（update.batch.entry.request / update.batch.entry.fail / update.batch.summary）
 * 共用 sessionHash = hash8(批次 id)；失败行用 stage 说清楚在哪一步失败、用 index 指向整批里
 * 第几家；总账用 stoppedBecause 说明为什么停，且与 host.lastRun.stoppedBecause 同口径。
 * 同时守住边界：没有属主（没 selfKey）时批量级一行不发，但会话该推进推进、该落盘落盘；
 * 落点自身抛错也不许影响驱动结果（日志是旁路，不是主路）。
 *
 * 事件清单先 prime 进进程；字段集合写错一个整行会被白名单丢掉，所以「恰好一条 + 字段集合相等」
 * 本身就是白名单断言。网络、落盘、子进程全用假件，不碰真机。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createBatchSession } from '../dist/batch.js'
import { hash8 } from '../dist/hash.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { primeUpdateEventTable } from '../dist/log/manifest.js'
import { batchPathsForOwner } from '../dist/store.js'
import {
  SILENT,
  bind,
  collector,
  fakeTransport,
  mkScope,
  mkTarget,
  rowsOf,
  unbindAll,
} from './helpers/batch-log-harness.mjs'

/** 从盘上读回属主的批量账本（「跨重启还能不能串起来」看的就是这份）。 */
async function readDiskSession(dir, owner = 'life') {
  const text = await readFile(batchPathsForOwner(dir, dir, owner).batchFile, 'utf8')
  return JSON.parse(text)
}

async function writeDiskSession(dir, session, owner = 'life') {
  const path = batchPathsForOwner(dir, dir, owner).batchFile
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(session), 'utf8')
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
  primeUpdateEventTable()
})

afterEach(() => {
  unbindAll()
})

describe('#208 同一批的会话串联', () => {
  it('入队 / 失败 / 总账三个落点共用一个 sessionHash，总账与 lastRun 同口径', async () => {
    const { scope } = await mkScope('batch-session-')
    // 顺序 [a,b,self]：a 装成、b 装失败、self 已最新 → ok 2 / failed 1 / total 3。
    const host = createMultiHostUpdate(
      {
        scope,
        logCtx: SILENT,
        transport: fakeTransport({
          a: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'done', restartRequired: false } },
          b: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'failed', error: 'install-failed' } },
          self: { check: { kind: 'current' } },
        }),
      },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('b'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    const b = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-b', b.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const expected = hash8(reply.session.id)

    const request = rowsOf(owner, 'update.batch.entry.request')
    const failed = rowsOf(b, 'update.batch.entry.fail')
    const summary = rowsOf(owner, 'update.batch.summary')
    assert.equal(request.length, 1)
    assert.equal(failed.length, 1)
    assert.equal(summary.length, 1)

    // 两条属主行、一条失败那家行：三个落点上的 sessionHash 必须能被认出是同一批。
    const hashes = [request[0], failed[0], summary[0]].map((row) => row.fields.sessionHash)
    for (const hash of hashes) assert.match(hash, /^[0-9a-f]{8}$/, 'sessionHash 是 8 位十六进制指纹')
    assert.equal(new Set(hashes).size, 1, '同一批的三条行共用一个 sessionHash')
    assert.equal(hashes[0], expected, 'sessionHash = hash8(批次 id)')

    // 失败行的 stage / index 与这一家的失败方式对位。
    assert.equal(failed[0].fields.errorKind, 'install-failed')
    assert.equal(failed[0].fields.stage, 'install')
    assert.equal(failed[0].fields.index, 1, 'b 在整批 [a,b,self] 里排第 1（0 起）')
    assert.equal(failed[0].fields.targetHash, hash8('b'))

    // 总账与 lastRun：两处必须说同一句话。
    assert.equal(summary[0].fields.total, 3)
    assert.equal(summary[0].fields.ok, 2)
    assert.equal(summary[0].fields.failed, 1)
    assert.equal(summary[0].fields.skipped, 0)
    assert.equal(summary[0].fields.stoppedBecause, 'finished')
    assert.equal(summary[0].fields.stoppedBecause, host.lastRun.stoppedBecause, '总账 stoppedBecause 与 lastRun 同口径')
    assert.equal(summary[0].fields.ok + summary[0].fields.failed + summary[0].fields.skipped, summary[0].fields.total)
    host.dispose()
  })

  it('重启后续跑：盘上会话号不变，查失败 / 装失败各落一条且 stage、index 对位', async () => {
    const { dir, scope } = await mkScope('batch-session-')
    // 模拟「上一进程被打断」：盘上留着一批 pending 的账本，id 就是重连后要认出的那个号。
    const disk = createBatchSession({
      id: 'session-208',
      keys: ['a', 'b', 'self'],
      selfKey: 'self',
      stopOnFailure: false,
      now: Date.now(),
    })
    await writeDiskSession(dir, disk)

    const host = createMultiHostUpdate(
      {
        scope,
        logCtx: SILENT,
        transport: fakeTransport({
          a: { check: { kind: 'failed', error: 'check-failed' } },
          b: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'failed', error: 'install-failed' } },
          self: { check: { kind: 'current' } },
        }),
      },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('b'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    const a = collector()
    const b = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-a', a.sink)
    bind('plugin-b', b.sink)

    const reply = await host.handlers['life.batchResume']({})
    assert.equal(reply.ok, true)
    assert.equal(reply.resumed, true)
    assert.equal(reply.session.id, 'session-208', '续跑认回盘上同一批')
    assert.equal(host.lastRun.stoppedBecause, 'finished')

    const aFailed = rowsOf(a, 'update.batch.entry.fail')
    const bFailed = rowsOf(b, 'update.batch.entry.fail')
    assert.equal(aFailed.length, 1)
    assert.equal(bFailed.length, 1)
    assert.equal(aFailed[0].fields.stage, 'check', '查出问题记 check 阶段')
    assert.equal(aFailed[0].fields.index, 0)
    assert.equal(aFailed[0].fields.errorKind, 'check-failed')
    assert.equal(bFailed[0].fields.stage, 'install')
    assert.equal(bFailed[0].fields.index, 1)
    const sessionHash = hash8('session-208')
    assert.equal(aFailed[0].fields.sessionHash, sessionHash, '续跑不换号：sessionHash 还是盘上那一批的')
    assert.equal(bFailed[0].fields.sessionHash, sessionHash)

    // 续跑也走到收尾：总账沿用同一个号。
    const summary = rowsOf(owner, 'update.batch.summary')
    assert.equal(summary.length, 1, '中断的一批跑完照样收尾一条')
    assert.equal(summary[0].fields.sessionHash, sessionHash)
    assert.equal(summary[0].fields.stoppedBecause, 'finished')
    assert.equal(summary[0].fields.failed, 2)
    assert.equal(summary[0].fields.ok, 1, 'self 已最新')

    // 盘上的账本也收敛了：重启前读到的是这批，重启后读到的还是这批，且每行都有结论。
    const after = await readDiskSession(dir)
    assert.equal(after.id, 'session-208')
    assert.deepEqual(
      after.entries.map((entry) => [entry.key, entry.phase]),
      [['a', 'failed'], ['b', 'failed'], ['self', 'current']],
      '续跑结果全部落盘（谁的结论都记在自己名下）',
    )
    host.dispose()
  })

  it('没有属主：批量级一行不发，但会话照样推进、账本照样落盘', async () => {
    const { dir, scope } = await mkScope('batch-session-')
    const host = createMultiHostUpdate(
      { scope, logCtx: SILENT, transport: fakeTransport({}) },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('b')] },
    )
    const a = collector()
    const b = collector()
    bind('plugin-a', a.sink)
    bind('plugin-b', b.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true, '没有落点不影响回包')
    const all = [...a.rows, ...b.rows]
    assert.equal(all.filter((row) => row.event.startsWith('update.batch.')).length, 0, '没有属主：批量级一行不发')
    // 目标单插件电话自己的失败行（如 updateStatus 的 unknown-profile）落各自目录，不属于批量电话行。
    const batchPhoneFails = all.filter(
      (row) => row.event === 'host.call.fail' && String(row.fields.kind ?? '').startsWith('batch-'),
    )
    assert.equal(batchPhoneFails.length, 0, '没有属主：批量电话失败行不发（目标单插件电话失败行另算）')

    // 没有落点 ≠ 没有账本：会话该推进推进、该落盘落盘。
    const disk = await readDiskSession(dir)
    assert.equal(disk.id, reply.session.id, '盘上就是这次这批')
    assert.deepEqual(
      disk.entries.map((entry) => [entry.key, entry.phase]),
      [['a', 'current'], ['b', 'current']],
      '两家都已最新：会话推进照旧',
    )
    assert.equal(host.lastRun.stoppedBecause, 'finished')
    assert.equal(rowsOf(a, 'update.batch.entry.request').length, 0)
    host.dispose()
  })

  it('落点自身抛错不影响驱动结果（日志是旁路）', async () => {
    const { scope } = await mkScope('batch-session-')
    const host = createMultiHostUpdate(
      {
        scope,
        transport: fakeTransport({
          a: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'failed', error: 'install-failed' } },
        }),
      },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    bind('plugin-self', owner.sink)
    // 这一家的落点每次都炸：驱动必须当没发生过，继续推进。
    bind('plugin-a', {
      fire: () => {
        throw new Error('落点炸了')
      },
    })

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true, '落点抛错不影响驱动结果')
    assert.equal(
      reply.session.entries.find((entry) => entry.key === 'a').phase,
      'failed',
      '该失败还是失败：推进不听日志的',
    )
    assert.equal(host.lastRun.stoppedBecause, 'finished')
    const summary = rowsOf(owner, 'update.batch.summary')
    assert.equal(summary.length, 1, '属主的落点没坏：总账照发')
    assert.equal(summary[0].fields.failed, 1)
    assert.equal(summary[0].fields.sessionHash, hash8(reply.session.id))
    host.dispose()
  })
})
