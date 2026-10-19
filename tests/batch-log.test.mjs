/**
 * tests/batch-log.test.mjs —— issue #124 批量侧的常驻事件接线：一批一条、一家失败一条、收尾一条。
 *
 * #208 起三事件都带 sessionHash（hash8(批次 id)）把同一批串起来；失败行再带 stage（失败阶段）
 * 与 index（整批 0 起序号）；总账带 stoppedBecause（为什么停）；七个批量电话失败各落一条
 * host.call.fail（属主目录，连续同码去重）。
 *
 * 只测外部行为：假传输推进批量，在注入的落点上**按插件标识分行**收集，然后断言
 *   (a) 一批只落 1 条 update.batch.entry.request，四个字段（三计数 + sessionHash）与计划一致；
 *   (b) 一个目标失败落 1 条 update.batch.entry.fail，targetHash 是指纹，路径原文一个字不入行，
 *       退出码只有真拿到才带，stage/index 按失败方式给；
 *   (c) 收尾落 1 条 update.batch.summary，ok + failed + skipped === total，时长按真时钟量；
 *       总账走「收尾边沿」：行内重试装成后再收尾会再记一条，计数跟着账本变（日志不写假话）；
 *   (d) 不注入端口时驱动器读数一字不差；没有落点（没 selfKey）时批量级一行不发。
 * 事件清单先 prime 进进程：字段白名单是活的，多一个字段整行会被发射口丢掉 ——
 * 所以「恰好一条 + 字段集合相等」本身就是白名单断言，不必再抄一遍清单。
 * 网络、落盘、子进程全用假件，不碰真机。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createBatchSession } from '../dist/batch.js'
import { runBatch } from '../dist/batch-run.js'
import { hash8 } from '../dist/hash.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { pruneEventFields } from '../dist/gate.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { currentUpdateEventTable, primeUpdateEventTable } from '../dist/log/manifest.js'
import {
  SILENT,
  bind,
  collector,
  fakeTransport,
  installOverrides,
  mkScope,
  mkTarget,
  phaseOf,
  rowsOf,
  seedQueue,
  unbindAll,
} from './helpers/batch-log-harness.mjs'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
  // 白名单是活的：字段集合写错一个，整行会被丢掉，下面的条数断言立刻红。
  primeUpdateEventTable()
})

afterEach(() => {
  unbindAll()
})

describe('#124 批量侧常驻事件', () => {
  it('一批只落一条入场行，三个计数与计划一致（own = 自己那家，foreign = 其余）', async () => {
    const { scope } = await mkScope()
    const host = createMultiHostUpdate(
      { scope, logCtx: SILENT, transport: fakeTransport({}) },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('b'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    const a = collector()
    const b = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-a', a.sink)
    bind('plugin-b', b.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const asked = rowsOf(owner, 'update.batch.entry.request')
    assert.equal(asked.length, 1, '一批只落一条入场行')
    assert.equal(asked[0].level, 'info')
    assert.deepEqual(
      Object.keys(asked[0].fields).sort(),
      ['foreignCount', 'ownCount', 'sessionHash', 'total'],
      '四个字段恰好：三计数 + #208 的 sessionHash',
    )
    assert.equal(asked[0].fields.total, 3)
    assert.equal(asked[0].fields.ownCount, 1, '自己 1 家')
    assert.equal(asked[0].fields.foreignCount, 2, '别人 2 家')
    assert.match(asked[0].fields.sessionHash, /^[0-9a-f]{8}$/, 'sessionHash 是 8 位十六进制指纹')
    assert.equal(asked[0].fields.sessionHash, hash8(reply.session.id), 'sessionHash = hash8(批次 id)')
    assert.equal(rowsOf(a, 'update.batch.entry.request').length, 0, '入场行落属主，不散给目标')
    assert.equal(rowsOf(b, 'update.batch.entry.request').length, 0)

    // 同一份已收尾的会话再续一次：没有新会话，就不该有新行，也不换 sessionHash。
    const resumed = await host.handlers['life.batchResume']({})
    assert.equal(resumed.resumed, false)
    assert.equal(rowsOf(owner, 'update.batch.entry.request').length, 1, '同一批不重复记')
    assert.equal(rowsOf(owner, 'update.batch.entry.request')[0].fields.sessionHash, asked[0].fields.sessionHash)

    // 再点一次「全部提交」= 新一批（新编号）：新的一批自有它的一条。
    await host.handlers['life.batchInstall']({})
    assert.equal(rowsOf(owner, 'update.batch.entry.request').length, 2, '一批一条：新会话重新记一条')
    host.dispose()
  })

  it('一个目标失败一条失败行：targetHash 不含路径原文，退出码真拿到才带', async () => {
    const { scope } = await mkScope()
    const pathKey = 'C:\\Users\\ann\\pkg-a'
    const host = createMultiHostUpdate(
      {
        scope,
        logCtx: SILENT,
        transport: fakeTransport({
          [pathKey]: {
            check: { kind: 'update', version: '2.0.0' },
            install: { kind: 'failed', error: 'install-failed', exitCode: 7 },
          },
          // 不像稳定码的错误（error.message 里可能有路径）：折成 unknown，原话一个字不入行。
          b: {
            check: { kind: 'update', version: '2.0.0' },
            install: { kind: 'failed', error: 'boom: /Users/ann/x 不见了 (C:\\tmp)' },
          },
        }),
      },
      { prefix: 'life', targets: [mkTarget(pathKey, 'a'), mkTarget('b', 'b'), mkTarget('self', 'self')], selfKey: 'self' },
    )
    const owner = collector()
    const a = collector()
    const b = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-a', a.sink)
    bind('plugin-b', b.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, pathKey), 'failed')

    const failed = rowsOf(a, 'update.batch.entry.fail')
    assert.equal(failed.length, 1, '一个目标失败一条')
    assert.equal(failed[0].level, 'warn')
    assert.deepEqual(
      Object.keys(failed[0].fields).sort(),
      ['errorKind', 'exitCode', 'index', 'sessionHash', 'stage', 'targetHash'],
      '字段恰好六个（#208 加 sessionHash / stage / index）',
    )
    assert.match(failed[0].fields.targetHash, /^[0-9a-f]{8}$/, 'targetHash 是 8 位十六进制指纹')
    assert.match(failed[0].fields.sessionHash, /^[0-9a-f]{8}$/, 'sessionHash 是 8 位十六进制指纹')
    assert.equal(failed[0].fields.sessionHash, hash8(reply.session.id), 'sessionHash = hash8(批次 id)')
    assert.equal(failed[0].fields.errorKind, 'install-failed')
    assert.equal(failed[0].fields.stage, 'install', '装失败记 install 阶段')
    assert.equal(failed[0].fields.index, 0, '批内序号：目标键在会话顺序里的位置（这家排第一）')
    assert.equal(failed[0].fields.exitCode, 7, '真拿到退出码就给')
    const text = JSON.stringify(failed)
    assert.ok(!text.includes('C:') && !text.includes('\\') && !text.includes('/'), '行里不许出现路径原文')
    assert.ok(!text.includes('Users'), '行里不许出现路径片段')

    const bFailed = rowsOf(b, 'update.batch.entry.fail')
    assert.equal(bFailed.length, 1)
    assert.deepEqual(Object.keys(bFailed[0].fields).sort(), ['errorKind', 'index', 'sessionHash', 'stage', 'targetHash'])
    assert.equal(bFailed[0].fields.errorKind, 'unknown', '不像稳定码的错误折成 unknown')
    assert.equal(bFailed[0].fields.index, 1)
    assert.equal(bFailed[0].fields.stage, 'install')
    assert.equal('exitCode' in bFailed[0].fields, false, '没拿到退出码就不给这个字段')
    assert.equal(rowsOf(owner, 'update.batch.entry.fail').length, 0, '失败行落失败那家，不发给属主')

    const all = JSON.stringify([...owner.rows, ...a.rows, ...b.rows])
    assert.ok(!all.includes(pathKey) && !all.includes('Users'), '任何一行都不含目标键原文')
    host.dispose()
  })

  it('收尾一条总账：ok + failed + skipped === total，时长是建会话到收尾的真测量', async () => {
    const { scope } = await mkScope()
    const clock = { at: 1000 }
    const host = createMultiHostUpdate(
      {
        scope,
        logCtx: SILENT,
        now: () => clock.at,
        transport: fakeTransport(
          {
            a: { check: { kind: 'current' } },
            b: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'done', restartRequired: true } },
            c: { check: { kind: 'skipped', version: '9.9.9' } },
            d: { check: { kind: 'failed', error: 'check-failed' } },
            self: { check: { kind: 'current' } },
          },
          () => {
            clock.at += 10
          },
        ),
      },
      {
        prefix: 'life',
        targets: [mkTarget('a'), mkTarget('b'), mkTarget('c'), mkTarget('d'), mkTarget('self')],
        selfKey: 'self',
      },
    )
    const owner = collector()
    bind('plugin-self', owner.sink)

    // 只推一家：整批没收尾就不该有总账（面板逐行「装这家」时尤其重要）。
    await host.handlers['life.batchInstall']({ keys: ['a'] })
    assert.equal(rowsOf(owner, 'update.batch.summary').length, 0, '整批没收尾不发总账')

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const summary = rowsOf(owner, 'update.batch.summary')
    assert.equal(summary.length, 1, '一次收尾一条总账')
    assert.equal(summary[0].level, 'info')
    const fields = summary[0].fields
    assert.deepEqual(
      Object.keys(fields).sort(),
      ['durationMs', 'failed', 'ok', 'resumed', 'sessionAgeMs', 'sessionHash', 'skipped', 'stoppedBecause', 'total'],
      '九个字段恰好（#208 加 sessionHash / stoppedBecause；#216 加 resumed / sessionAgeMs）',
    )
    assert.equal(fields.total, 5)
    assert.equal(fields.ok, 3, 'a 已最新 + b 装完 + self 已最新 = ok 3')
    assert.equal(fields.failed, 1, 'd 查失败 1')
    assert.equal(fields.skipped, 1, 'c 跳过 1')
    assert.equal(fields.durationMs, 50, '本次推进的活跃时长：4 次预查 + 1 次安装 = 5 次传输 ×10ms；此前单家推进那 10ms 不算本轮（#216）')
    assert.equal(fields.sessionAgeMs, 60, '会话年龄从建会话量到收尾：首次单家推进 10ms + 本轮 50ms（#216）')
    assert.equal(fields.resumed, false, '全新一批不是续跑（#216）')
    assert.match(fields.sessionHash, /^[0-9a-f]{8}$/)
    assert.equal(fields.sessionHash, hash8(reply.session.id))
    assert.equal(fields.stoppedBecause, 'finished', '全部跑完（有失败也算收尾）')
    assert.equal(fields.ok + fields.failed + fields.skipped, fields.total, '三个计数必须把 total 分完')
    host.dispose()
  })

  it('重试装成后再收尾：总账按收尾边沿再记一条，ok / failed 跟着账本变', async () => {
    const { scope } = await mkScope()
    const script = {
      a: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'failed', error: 'install-failed', exitCode: 5 } },
      self: { check: { kind: 'current' } },
    }
    const host = createMultiHostUpdate(
      { scope, logCtx: SILENT, transport: fakeTransport(script) },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    bind('plugin-self', owner.sink)
    const sum = (fields) => fields.ok + fields.failed + fields.skipped

    const failed = await host.handlers['life.batchInstall']({})
    assert.equal(failed.ok, true)
    const first = rowsOf(owner, 'update.batch.summary')
    assert.equal(first.length, 1, '失败也算收尾，记一条')
    assert.equal(first[0].fields.total, 2)
    assert.equal(first[0].fields.ok, 1, 'self 已最新')
    assert.equal(first[0].fields.failed, 1, 'a 装失败')
    assert.equal(first[0].fields.skipped, 0)
    assert.equal(first[0].fields.stoppedBecause, 'finished')
    assert.equal(sum(first[0].fields), first[0].fields.total)

    // 用户点行内「重试」：这一家真装成（同一份会话，账本从失败变好）。
    script.a.install = { kind: 'done', restartRequired: false }
    const retried = await host.handlers['life.batchInstall']({ keys: ['a'] })
    assert.equal(retried.ok, true)
    const both = rowsOf(owner, 'update.batch.summary')
    assert.equal(both.length, 2, '装成后又收尾了一次：再记一条（日志不许还写着 failed:1）')
    assert.equal(both[1].fields.ok, 2, 'ok 跟着账本从 1 变 2')
    assert.equal(both[1].fields.failed, 0, 'failed 跟着账本从 1 变 0')
    assert.equal(both[1].fields.skipped, 0)
    assert.equal(both[1].fields.stoppedBecause, 'finished')
    assert.equal(both[1].fields.sessionHash, both[0].fields.sessionHash, '同一批：重发总账也沿用同一个 sessionHash')
    assert.equal(sum(both[1].fields), both[1].fields.total)
    assert.ok(both[1].fields.sessionAgeMs >= both[0].fields.sessionAgeMs, '会话年龄是累计真测量（#216：durationMs 已改为本次推进的活跃时长，不再会话累计）')

    // 对已经装成的行再点一次「装这家」：没有可重试的行，就没有「没收尾 → 收尾」这个边沿。
    await host.handlers['life.batchInstall']({ keys: ['a'] })
    assert.equal(rowsOf(owner, 'update.batch.summary').length, 2, '没有掉出收尾就不重复记')
    host.dispose()
  })

  it('没有 selfKey（落点未知）：批量级一行不发，推进与回包照旧', async () => {
    const { scope } = await mkScope()
    const host = createMultiHostUpdate(
      { scope, logCtx: SILENT, transport: fakeTransport({}) },
      { prefix: 'life', targets: [mkTarget('a')] },
    )
    const a = collector()
    bind('plugin-a', a.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'current', '没有落点不影响推进（已最新照旧收尾）')
    assert.equal(rowsOf(a, 'update.batch.entry.request').length, 0)
    assert.equal(rowsOf(a, 'update.batch.summary').length, 0)
    host.dispose()
  })

  it('不注入端口：驱动器读数一字不差（端口抛错也一样）', async () => {
    const drive = async (logFor) => {
      const session = createBatchSession({ id: 'batch-log-d', keys: ['bad'], selfKey: null, stopOnFailure: false, now: 1000 })
      const saved = []
      const result = await runBatch(session, {
        check: async () => ({ kind: 'update', version: '2.0.0' }),
        install: async () => ({ kind: 'failed', error: 'install-failed', exitCode: 3 }),
        save: (next) => {
          saved.push(next)
        },
        now: () => 2000,
        ...(logFor ? { logFor } : {}),
      })
      return { result, saved: saved.length }
    }

    const rows = []
    const withPort = await drive(() => (level, event, fields) => rows.push({ level, event, fields }))
    const without = await drive(undefined)
    assert.equal(rows.length, 1, '注入端口才有一行')
    assert.equal(rows[0].event, 'update.batch.entry.fail')
    assert.equal(rows[0].fields.errorKind, 'install-failed')
    assert.equal(rows[0].fields.exitCode, 3)
    assert.equal(rows[0].fields.stage, 'install', '装提交失败缺省记 install 阶段')
    assert.equal(rows[0].fields.index, 0, '批内序号：唯一那家就是 0')
    assert.equal(rows[0].fields.sessionHash, hash8('batch-log-d'), 'sessionHash = hash8(会话 id)')
    assert.deepEqual(withPort.result.session, without.result.session, '有端口 / 没端口：会话读数一字不差')
    assert.deepEqual(withPort.result.steps, without.result.steps, '步骤一字不差')
    assert.equal(withPort.result.stoppedBecause, without.result.stoppedBecause)
    assert.equal(withPort.saved, without.saved, '落盘次数一字不差')

    // 端口抛错：同样不许影响推进（best-effort 的底线）。
    const boom = await drive(() => () => {
      throw new Error('落点炸了')
    })
    assert.deepEqual(boom.result.session, without.result.session, '端口抛错与没有端口一字不差')
    assert.equal(boom.result.stoppedBecause, without.result.stoppedBecause)
  })
})

describe('#208 批量会话串联字段', () => {
  it('同一批的三条行共用一个 sessionHash：入队、失败、总账彼此相等，续跑不换号', async () => {
    const { scope } = await mkScope()
    const host = createMultiHostUpdate(
      {
        scope,
        transport: fakeTransport({
          a: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'failed', error: 'install-failed' } },
        }),
      },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('b'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    const a = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-a', a.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const request = rowsOf(owner, 'update.batch.entry.request')
    const failed = rowsOf(a, 'update.batch.entry.fail')
    const summary = rowsOf(owner, 'update.batch.summary')
    assert.equal(request.length, 1)
    assert.equal(failed.length, 1)
    assert.equal(summary.length, 1)

    const expected = hash8(reply.session.id)
    const hashes = [request[0], failed[0], summary[0]].map((row) => row.fields.sessionHash)
    for (const hash of hashes) assert.match(hash, /^[0-9a-f]{8}$/)
    assert.equal(new Set(hashes).size, 1, '同一批的三条行必须是同一个 sessionHash')
    assert.equal(hashes[0], expected, 'sessionHash = hash8(批次 id)')

    // 已收尾的一批再「接着上次」：没有新会话，就不该换号、也不该补新行。
    const resumed = await host.handlers['life.batchResume']({})
    assert.equal(resumed.resumed, false)
    const after = [
      ...rowsOf(owner, 'update.batch.entry.request'),
      ...rowsOf(a, 'update.batch.entry.fail'),
      ...rowsOf(owner, 'update.batch.summary'),
    ]
    assert.equal(after.length, 3, '同一批不重复记')
    assert.equal(new Set(after.map((row) => row.fields.sessionHash)).size, 1, '同一批只有一个 sessionHash')
    host.dispose()
  })

  it('失败行的 index 是整批 order 里的序号（self 排最后也按位）', async () => {
    const { scope } = await mkScope()
    // selfKey=c 时 order 仍是 [a,b,c]（c 本来就在最后）；b、c 都装失败 → index 1 / 2。
    const host = createMultiHostUpdate(
      {
        scope,
        transport: fakeTransport({
          a: { check: { kind: 'current' } },
          b: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'failed', error: 'install-failed' } },
          c: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'failed', error: 'install-failed' } },
        }),
      },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('b'), mkTarget('c')], selfKey: 'c' },
    )
    const owner = collector()
    const b = collector()
    bind('plugin-c', owner.sink)
    bind('plugin-b', b.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.session.order, ['a', 'b', 'c'], '账本顺序：全清单，自己最后')

    const bFailed = rowsOf(b, 'update.batch.entry.fail')
    const cFailed = rowsOf(owner, 'update.batch.entry.fail')
    assert.equal(bFailed.length, 1)
    assert.equal(cFailed.length, 1)
    assert.equal(bFailed[0].fields.index, 1, 'b 在整批里排第 1（0 起）')
    assert.equal(cFailed[0].fields.index, 2, 'self（c）排最后，序号照位给')
    assert.equal(bFailed[0].fields.sessionHash, cFailed[0].fields.sessionHash, '同一批两条失败行共用一个 sessionHash')
    assert.equal(cFailed[0].fields.stage, 'install')
    host.dispose()
  })

  it('失败阶段 stage：驱动直驱时查失败记 check、装失败记 install', async () => {
    const run = async (id, checkOutcome, installOutcome) => {
      const rows = []
      const session = createBatchSession({ id, keys: ['t0', 't1'], selfKey: null, now: 1000 })
      const result = await runBatch(session, {
        check: async (key) => (key === 't0' ? checkOutcome : { kind: 'current' }),
        install: async () => installOutcome,
        save: async () => {},
        now: () => 2000,
        indexOf: (key) => session.order.indexOf(key),
        logFor: () => (level, event, fields) => rows.push({ level, event, fields }),
      })
      return { result, rows }
    }

    const checked = await run('batch-log-stage-check', { kind: 'failed', error: 'check-failed' }, { kind: 'done', restartRequired: false })
    assert.equal(checked.rows.length, 1)
    const checkFields = checked.rows[0].fields
    assert.equal(checked.rows[0].event, 'update.batch.entry.fail')
    assert.equal(checkFields.stage, 'check', '查失败记 check 阶段')
    assert.equal(checkFields.index, 0)
    assert.equal(checkFields.errorKind, 'check-failed')
    assert.equal(checkFields.sessionHash, hash8('batch-log-stage-check'))
    assert.equal(checkFields.targetHash, hash8('t0'))

    const installed = await run('batch-log-stage-install', { kind: 'update', version: '2.0.0' }, { kind: 'failed', error: 'install-failed' })
    assert.equal(installed.rows.length, 1)
    const installFields = installed.rows[0].fields
    assert.equal(installFields.stage, 'install', '提交安装失败记 install 阶段')
    assert.equal(installFields.index, 0)
    assert.equal(installFields.sessionHash, hash8('batch-log-stage-install'))
  })

  it('失败阶段 stage：等收尾超时记 timeout，收尾终态失败记 settle（真装路径）', async () => {
    // 超时：装电话返回后任务一直非终态，安装时限一到驱动器按 timeout 收。
    const timingOut = await mkScope()
    const timeoutHost = createMultiHostUpdate(
      {
        scope: timingOut.scope,
        installPollMs: 2,
        config: { installTimeoutMs: 60 },
        // 装永不返回：后台任务一直是 installing，等收尾只能等到时限。
        readerOverrides: installOverrides(timingOut.dir, 'pkg-a', () => new Promise(() => {})),
      },
      { prefix: 'life', targets: [mkTarget('a')], selfKey: 'a' },
    )
    const timed = collector()
    bind('plugin-a', timed.sink)
    const first = await timeoutHost.handlers['life.batchInstall']({})
    assert.equal(first.ok, true)
    const timeoutRows = rowsOf(timed, 'update.batch.entry.fail')
    assert.equal(timeoutRows.length, 1)
    assert.equal(timeoutRows[0].fields.stage, 'timeout', '等收尾超时不是提交失败，如实记 timeout')
    assert.equal(timeoutRows[0].fields.errorKind, 'install-failed')
    assert.equal(timeoutRows[0].fields.index, 0)
    assert.equal(timeoutRows[0].fields.sessionHash, hash8(first.session.id))
    timeoutHost.dispose()

    // 收尾失败：装到终态才失败（后台任务 failed），阶段记 settle。
    const settling = await mkScope()
    const settleHost = createMultiHostUpdate(
      {
        scope: settling.scope,
        installPollMs: 2,
        config: { installTimeoutMs: 5000 },
        readerOverrides: installOverrides(settling.dir, 'pkg-b', async () => {
          throw new Error('exec crashed')
        }),
      },
      { prefix: 'life', targets: [mkTarget('b')], selfKey: 'b' },
    )
    const settled = collector()
    bind('plugin-b', settled.sink)
    const second = await settleHost.handlers['life.batchInstall']({})
    assert.equal(second.ok, true)
    const settleRows = rowsOf(settled, 'update.batch.entry.fail')
    assert.equal(settleRows.length, 1)
    assert.equal(settleRows[0].fields.stage, 'settle', '装到终态才失败记 settle 阶段')
    assert.equal(settleRows[0].fields.errorKind, 'install-failed')
    settleHost.dispose()
  })

  it('stopOnFailure：首家失败就停、不收尾不发总账；重试推完才收尾 stoppedBecause=finished', async () => {
    const { scope } = await mkScope()
    const script = {
      a: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'failed', error: 'install-failed' } },
      b: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'done', restartRequired: false } },
      self: { check: { kind: 'current' } },
    }
    const host = createMultiHostUpdate(
      { scope, transport: fakeTransport(script) },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('b'), mkTarget('self')], selfKey: 'self', stopOnFailure: true },
    )
    const owner = collector()
    bind('plugin-self', owner.sink)

    const first = await host.handlers['life.batchInstall']({})
    assert.equal(first.ok, true)
    assert.equal(host.lastRun.stoppedBecause, 'stopped-after-failure', '首家失败即停')
    assert.deepEqual(
      first.session.entries.map((entry) => [entry.key, entry.phase]),
      [['a', 'failed'], ['b', 'ready'], ['self', 'current']],
      '停在失败那家；后面几家不推进',
    )
    // #209：没收尾也要有一行——记的是「为什么停」，不是「跑完了」。
    const stopped = rowsOf(owner, 'update.batch.summary')
    assert.equal(stopped.length, 1, '未收尾就停下：另记一条异常停止')
    assert.equal(stopped[0].fields.stoppedBecause, 'stopped-after-failure', '按策略遇错停：如实写原因')
    assert.equal(stopped[0].fields.failed, 1)
    assert.equal(stopped[0].fields.sessionHash, hash8(first.session.id))

    // 行内「重试」= batchInstall { keys }：把失败行复位再推（failed 对 batchResume 是终态，
    // 断点续跑不会重装失败那家，重试入口是带 keys 的安装）。
    script.a.install = { kind: 'done', restartRequired: false }
    const second = await host.handlers['life.batchInstall']({ keys: ['a', 'b', 'self'] })
    assert.equal(second.ok, true)
    const summary = rowsOf(owner, 'update.batch.summary')
    assert.equal(summary.length, 2, '停止行 + 收尾总账各一条')
    assert.equal(summary[1].fields.stoppedBecause, 'finished', '重试推完了：stoppedBecause=finished')
    assert.equal(summary[1].fields.stoppedBecause, host.lastRun.stoppedBecause, '总账与 lastRun 同口径')
    assert.equal(summary[1].fields.total, 3)
    assert.equal(summary[1].fields.ok, 3)
    assert.equal(summary[1].fields.failed, 0)
    assert.equal(summary[1].fields.sessionHash, rowsOf(owner, 'update.batch.entry.request')[0].fields.sessionHash, '同一批：总账沿用入场行的 sessionHash')
    host.dispose()
  })

  it('排队行归属：update-busy 排队的队列行落目标插件目录，不落属主', async () => {
    const { dir, scope } = await mkScope()
    // 队首是别家：本批第一家提交安装只会被公平门拦下（update-busy），驱动器按 queued 停。
    await seedQueue(dir, [
      { pluginId: 'other-plugin', requestId: 'req-other', targetVersion: null, enqueuedAt: Date.now() },
    ])
    const host = createMultiHostUpdate(
      {
        scope,
        installPollMs: 5,
        // 真路径假读侧；不注入 readQueue/writeQueue，队列读写走批量共享端口（#208 的 logFor 修复点）。
        readerOverrides: installOverrides(dir, 'pkg-a', async () => {}),
      },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    const a = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-a', a.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(host.lastRun.stoppedBecause, 'queued', '排队即停，不把别家误标 failed')
    assert.equal(phaseOf(reply.session, 'a'), 'ready', '排上队：相位退回 ready')
    // #209：排队即停也有一行「为什么停」——「排上队但没轮到」不能让面板看起来像卡死。
    const queuedStop = rowsOf(owner, 'update.batch.summary')
    assert.equal(queuedStop.length, 1, '未收尾就停下：另记一条异常停止')
    assert.equal(queuedStop[0].fields.stoppedBecause, 'queued')
    assert.equal(queuedStop[0].fields.failed, 0, '排队不是失败，failed 计数不动')

    const queueRows = rowsOf(a, 'update.queue.transition')
    assert.ok(queueRows.length >= 1, '排队边沿要留队列行（#208 队列端口接线修复）')
    assert.equal(queueRows[0].fields.phase, 'queued')
    assert.equal(rowsOf(owner, 'update.queue.transition').length, 0, '队列行跟动作方（目标）走，不落属主')
    host.dispose()
  })

  it('七个批量电话各失败一次：各落一条 host.call.fail 到属主目录', async () => {
    const one = await mkScope()
    const other = await mkScope()
    const targets = [mkTarget('a'), { ...mkTarget('b'), profileDir: other.dir }, mkTarget('self')]
    const host = createMultiHostUpdate({ scope: one.scope }, { prefix: 'life', targets, selfKey: 'self' })
    const owner = collector()
    const a = collector()
    const b = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-a', a.sink)
    bind('plugin-b', b.sink)

    const phones = [
      ['status', 'batch-status'],
      ['check', 'batch-check'],
      ['install', 'batch-install'],
      ['resume', 'batch-resume'],
      ['cancel', 'batch-cancel'],
      ['prefs', 'batch-prefs'],
      ['prefsSave', 'batch-prefs-save'],
    ]
    for (const [short] of phones) {
      const reply = await host.handlers[host.phoneNames[short]]({})
      assert.equal(reply.ok, false, short)
      assert.equal(reply.error, 'cross-scope', short)
    }

    const rows = rowsOf(owner, 'host.call.fail')
    assert.equal(rows.length, 7, '七个批量电话各失败一次 → 各一条，不多不少')
    const byMethod = new Map(rows.map((row) => [row.fields.method, row.fields]))
    for (const [short, kind] of phones) {
      const method = host.phoneNames[short]
      const fields = byMethod.get(method)
      assert.ok(fields, method + ' 要有一条失败行')
      assert.deepEqual(Object.keys(fields).sort(), ['error', 'errorHash', 'kind', 'method', 'pluginId'])
      assert.equal(fields.method, method, 'method 用全名')
      assert.equal(fields.kind, kind, 'kind 用短名')
      assert.equal(fields.error, 'cross-scope', 'error 是稳定码')
      assert.equal(fields.errorHash, hash8(method + '|cross-scope'), 'errorHash = hash8(method|error)')
      assert.equal(fields.pluginId, 'plugin-self', '落属主 pluginId')
    }
    // 批量电话的失败行与单插件目标的 host.call.fail 要能分清：目标目录里一条都没有（这批没单插件电话）。
    assert.equal(rowsOf(a, 'host.call.fail').length, 0)
    assert.equal(rowsOf(b, 'host.call.fail').length, 0)
    assert.ok(rows.every((row) => row.fields.method.startsWith('life.batch')), '批量电话行只认批量全名')
    // 有属主时批量面板的 logAppend 转发到属主。
    assert.equal(host.phoneNames.logAppend, 'life.logAppend')
    assert.equal(typeof host.handlers['life.logAppend'], 'function')
    host.dispose()
  })

  it('没有属主：七个电话各失败一次也一条不发；批量级事件同样全无', async () => {
    const one = await mkScope()
    const other = await mkScope()
    const targets = [mkTarget('a'), { ...mkTarget('b'), profileDir: other.dir }, mkTarget('self')]
    const host = createMultiHostUpdate({ scope: one.scope }, { prefix: 'life', targets })
    const a = collector()
    const b = collector()
    const selfTarget = collector()
    bind('plugin-a', a.sink)
    bind('plugin-b', b.sink)
    bind('plugin-self', selfTarget.sink)

    for (const short of ['status', 'check', 'install', 'resume', 'cancel', 'prefs', 'prefsSave']) {
      const reply = await host.handlers[host.phoneNames[short]]({})
      assert.equal(reply.ok, false, short)
    }
    const all = [...a.rows, ...b.rows, ...selfTarget.rows]
    assert.equal(all.filter((row) => row.event === 'host.call.fail').length, 0, '没有属主：批量电话失败行一条不发')
    assert.equal(all.filter((row) => row.event.startsWith('update.batch.')).length, 0, '批量级三事件同样一行不发')
    // 没有属主就没有批量面板日志落点：不登记转发。
    assert.equal('logAppend' in host.phoneNames, false)
    assert.equal('life.logAppend' in host.handlers, false)
    host.dispose()
  })

  it('批量失败行的去重：同一电话连续同码一条，成功一次清掉记忆后再记一条', async () => {
    const { scope } = await mkScope()
    const host = createMultiHostUpdate(
      { scope, transport: fakeTransport({}) },
      { prefix: 'life', targets: [mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    bind('plugin-self', owner.sink)

    const bad = await host.handlers['life.batchPrefsSave']({ checkOnOpen: 'nope' })
    const badAgain = await host.handlers['life.batchPrefsSave']({ checkOnOpen: 'nope' })
    assert.equal(bad.ok, false)
    assert.equal(badAgain.ok, false)
    let rows = rowsOf(owner, 'host.call.fail')
    assert.equal(rows.length, 1, '同一 method 连续同 error 只记首次')

    // 成功一次 = 清记忆：下一次失败重新算一条新边沿。
    const ok = await host.handlers['life.batchPrefsSave']({ checkOnOpen: true })
    assert.equal(ok.ok, true)
    rows = rowsOf(owner, 'host.call.fail')
    assert.equal(rows.length, 1, '成功本身不发失败行')
    const badAfterOk = await host.handlers['life.batchPrefsSave']({ checkOnOpen: 'nope' })
    assert.equal(badAfterOk.ok, false)
    rows = rowsOf(owner, 'host.call.fail')
    assert.equal(rows.length, 2, '成功清除记忆后，再失败重新记一条')
    assert.equal(rows[0].fields.errorHash, rows[1].fields.errorHash, '同一 method 同一 error：errorHash 相同（指纹可聚合）')
    host.dispose()
  })

  // ---------- #209：预查失败 / 驱动异常 / 用户取消 也各有 1 行 ----------

  it('预查失败：失败那家落一条 entry.fail（stage check），不再静默', async () => {
    const { scope } = await mkScope()
    const script = {
      a: { check: { kind: 'failed', error: 'check-failed' } },
      self: { check: { kind: 'current' } },
    }
    const host = createMultiHostUpdate(
      { scope, transport: fakeTransport(script) },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    const a = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-a', a.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true, '预查失败如实收敛进账本，不再整批回错')
    assert.equal(phaseOf(reply.session, 'a'), 'failed')
    const failRows = rowsOf(a, 'update.batch.entry.fail')
    assert.equal(failRows.length, 1, '一个预查失败目标一条')
    assert.deepEqual(Object.keys(failRows[0].fields).sort(), ['errorKind', 'index', 'sessionHash', 'stage', 'targetHash'])
    assert.equal(failRows[0].fields.stage, 'check', '预查失败记 check 阶段（与驱动失败同一张表）')
    assert.equal(failRows[0].fields.errorKind, 'check-failed')
    assert.equal(failRows[0].fields.index, 0, 'index 是整批 order 里的序号')
    assert.equal(failRows[0].fields.sessionHash, hash8(reply.session.id))
    host.dispose()
  })

  it('驱动异常：预查抛错 → 那家一条 entry.fail + 整批一条 stoppedBecause=error，不再被吞', async () => {
    const { scope } = await mkScope()
    const transport = {
      check: async (key) => {
        if (key === 'a') throw new Error('check crashed')
        return { kind: 'current' }
      },
      install: async () => ({ kind: 'done', restartRequired: false }),
    }
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    const a = collector()
    bind('plugin-self', owner.sink)
    bind('plugin-a', a.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, false, '传输崩溃沿旧口径回 ok:false')
    const failRows = rowsOf(a, 'update.batch.entry.fail')
    assert.equal(failRows.length, 1, '抛错那家也要说「哪家没查成」')
    assert.equal(failRows[0].fields.stage, 'check')
    assert.equal(failRows[0].fields.errorKind, 'unknown', '异常 message 可能有路径/URL：折成稳定码 unknown')
    const stopRows = rowsOf(owner, 'update.batch.summary')
    assert.equal(stopRows.length, 1, '驱动异常也是一次「停止」')
    assert.equal(stopRows[0].fields.stoppedBecause, 'error')
    assert.equal(stopRows[0].fields.sessionHash, failRows[0].fields.sessionHash, '停止行与失败行同一份账本')
    host.dispose()
  })

  it('驱动异常时停止行的计数取最新账本：装好的家不会被算成没装', async () => {
    const { scope } = await mkScope()
    const transport = {
      check: async () => ({ kind: 'update', version: '2.0.0' }),
      install: async (key) => {
        if (key === 'self') throw new Error('install crashed after first done')
        return { kind: 'done', restartRequired: false }
      },
    }
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    bind('plugin-self', owner.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, false)
    const stopRows = rowsOf(owner, 'update.batch.summary')
    assert.equal(stopRows.length, 1, '驱动异常一条停止行')
    assert.equal(stopRows[0].fields.stoppedBecause, 'error')
    assert.equal(stopRows[0].fields.total, 2)
    assert.equal(stopRows[0].fields.ok, 1, '先装好的那家已落盘：停止行的 ok 必须是 1 而不是 0')
    assert.equal(stopRows[0].fields.failed, 0)
    host.dispose()
  })

  it('用户取消：清账本前记一条 stoppedBecause=user-cancel，同一份账本只记一次', async () => {
    const { dir, scope } = await mkScope()
    await seedQueue(dir, [
      { pluginId: 'other-plugin', requestId: 'req-other', targetVersion: null, enqueuedAt: Date.now() },
    ])
    const host = createMultiHostUpdate(
      {
        scope,
        installPollMs: 5,
        readerOverrides: installOverrides(dir, 'pkg-a', async () => {}),
      },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    bind('plugin-self', owner.sink)

    const queued = await host.handlers['life.batchInstall']({})
    assert.equal(host.lastRun.stoppedBecause, 'queued')
    assert.equal(queued.ok, true)
    const before = rowsOf(owner, 'update.batch.summary')
    assert.equal(before.length, 1, '排队停止已有 1 行')

    const cancelled = await host.handlers['life.batchCancel']({})
    assert.equal(cancelled.ok, true)
    const after = rowsOf(owner, 'update.batch.summary')
    assert.equal(after.length, 2, '用户取消也是一次停止，记一行')
    assert.equal(after[1].fields.stoppedBecause, 'user-cancel')
    assert.equal(after[1].fields.sessionHash, before[0].fields.sessionHash, '同一份账本：sessionHash 相同')

    // 再取消一次：账本已空，不再记（同一会话同一原因只一条）。
    await host.handlers['life.batchCancel']({})
    assert.equal(rowsOf(owner, 'update.batch.summary').length, 2)
    host.dispose()
  })

  // ADR-0006 的「改三处」：新增枚举除了清单与发射点，还要有负断言——表外值被摘成字段级降级，
  // 整行其余字段照落（不是整行丢）。这里直接对真清单跑裁剪器，钉住 stage / stoppedBecause 的逐值登记。
  it('负断言：stage 与 stoppedBecause 只收清单登记过的值（表外值摘字段，整行不丢）', () => {
    const table = currentUpdateEventTable()
    assert.ok(table, '事件清单已 prime（beforeEach 装进来的）')

    const failFields = {
      targetHash: 'deadbeef',
      sessionHash: 'cafebabe',
      errorKind: 'check-failed',
      stage: 'bogus-stage',
      index: 2,
    }
    const pruned = pruneEventFields(table, 'update.batch.entry.fail', failFields)
    assert.deepEqual(pruned.prunedFields, [{ field: 'stage', reason: 'invalid-enum' }])
    assert.deepEqual(pruned.keptFields, {
      targetHash: 'deadbeef',
      sessionHash: 'cafebabe',
      errorKind: 'check-failed',
      index: 2,
    }, '摘掉的只是表外 stage，整行其余字段照落')
    for (const stage of ['check', 'install', 'timeout', 'settle']) {
      const ok = pruneEventFields(table, 'update.batch.entry.fail', { ...failFields, stage })
      assert.equal(ok.ok, true, stage + ' 是登记值，不该被摘')
    }

    const summaryFields = {
      total: 3,
      ok: 1,
      failed: 1,
      skipped: 1,
      durationMs: 10,
      sessionHash: 'cafebabe',
      stoppedBecause: 'bogus',
    }
    const summaryPruned = pruneEventFields(table, 'update.batch.summary', summaryFields)
    assert.deepEqual(summaryPruned.prunedFields, [{ field: 'stoppedBecause', reason: 'invalid-enum' }])
    for (const value of ['finished', 'stopped-after-failure', 'max-steps', 'empty', 'queued', 'user-cancel', 'error']) {
      const ok = pruneEventFields(table, 'update.batch.summary', { ...summaryFields, stoppedBecause: value })
      assert.equal(ok.ok, true, value + ' 是登记值，不该被摘')
    }
  })
})
