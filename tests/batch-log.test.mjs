/**
 * tests/batch-log.test.mjs —— issue #124 批量侧的常驻事件接线：一批一条、一家失败一条、收尾一条。
 *
 * 只测外部行为：假传输推进批量，在注入的落点上**按插件标识分行**收集，然后断言
 *   (a) 一批只落 1 条 update.batch.entry.request，三个计数与构造出的计划一致；
 *   (b) 一个目标失败落 1 条 update.batch.entry.fail，targetHash 是指纹，路径原文一个字不入行，
 *       退出码只有真拿到才带；
 *   (c) 收尾落 1 条 update.batch.summary，ok + failed + skipped === total，时长按真时钟量；
 *       总账走「收尾边沿」：行内重试装成后再收尾会再记一条，计数跟着账本变（日志不写假话）；
 *   (d) 不注入端口时驱动器读数一字不差；没有落点（没 selfKey）时批量级一行不发。
 * 事件清单先 prime 进进程：字段白名单是活的，多一个字段整行会被发射口丢掉 ——
 * 所以「恰好一条 + 字段 deepEqual」本身就是白名单断言，不必再抄一遍清单。
 * 网络、落盘、子进程全用假件，不碰真机。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBatchSession } from '../dist/batch.js'
import { runBatch } from '../dist/batch-run.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { primeUpdateEventTable } from '../dist/log/manifest.js'
import { updateLogRouter } from '../dist/log/router.js'

/** 构造期用的静默落点：真正要断言的落点在构造之后再按插件标识绑上。 */
const SILENT = { fire: () => {} }

/** 本文件绑过的插件标识，收尾逐个解绑（路由表是进程级的，别漏给同进程的其它文件）。 */
const bound = []

function bind(pluginId, sink) {
  updateLogRouter.bind(pluginId, sink)
  bound.push(pluginId)
}

/** 一份行收集器：写下来的就是发射口真发出去、路由真送到的那些行。 */
function collector() {
  const rows = []
  return { rows, sink: { fire: (level, event, fields) => rows.push({ level, event, fields }) } }
}

function rowsOf(store, event) {
  return store.rows.filter((row) => row.event === event)
}

/** 假传输：按目标键给读数，顺带把每次调用报给 onCall（假时钟靠它走）。 */
function fakeTransport(script, onCall) {
  return {
    check: async (key) => {
      onCall?.()
      return script[key]?.check ?? { kind: 'current' }
    },
    install: async (key) => {
      onCall?.()
      return script[key]?.install ?? { kind: 'done', restartRequired: false }
    },
  }
}

/** 一个批量目标：键是会话内稳定键，tag 只用来拼包名/前缀/插件标识（键可能是路径，不能当标识）。 */
function mkTarget(key, tag = key) {
  return { key, title: key, packageName: 'pkg-' + tag, prefix: 'p-' + tag, pluginId: 'plugin-' + tag }
}

/** 真临时目录当使用范围：会话账本落这儿，不碰真机家目录。 */
async function mkScope() {
  const dir = await mkdtemp(join(tmpdir(), 'batch-log-'))
  return { dir, scope: { homeDir: dir, profileDir: dir } }
}

function phaseOf(session, key) {
  return session.entries.find((entry) => entry.key === key)?.phase ?? null
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
  // 白名单是活的：字段集合写错一个，整行会被丢掉，下面的条数断言立刻红。
  primeUpdateEventTable()
})

afterEach(() => {
  while (bound.length > 0) updateLogRouter.unbind(bound.pop())
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
    assert.deepEqual(asked[0].fields, { total: 3, ownCount: 1, foreignCount: 2 }, '三键口径：自己 1 家、别人 2 家')
    assert.equal(rowsOf(a, 'update.batch.entry.request').length, 0, '入场行落属主，不散给目标')
    assert.equal(rowsOf(b, 'update.batch.entry.request').length, 0)

    // 同一份已收尾的会话再续一次：没有新会话，就不该有新行。
    const resumed = await host.handlers['life.batchResume']({})
    assert.equal(resumed.resumed, false)
    assert.equal(rowsOf(owner, 'update.batch.entry.request').length, 1, '同一批不重复记')

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
    assert.deepEqual(Object.keys(failed[0].fields).sort(), ['errorKind', 'exitCode', 'targetHash'], '字段恰好三个')
    assert.match(failed[0].fields.targetHash, /^[0-9a-f]{8}$/, 'targetHash 是 8 位十六进制指纹')
    assert.equal(failed[0].fields.errorKind, 'install-failed')
    assert.equal(failed[0].fields.exitCode, 7, '真拿到退出码就给')
    const text = JSON.stringify(failed)
    assert.ok(!text.includes('C:') && !text.includes('\\') && !text.includes('/'), '行里不许出现路径原文')
    assert.ok(!text.includes('Users'), '行里不许出现路径片段')

    const bFailed = rowsOf(b, 'update.batch.entry.fail')
    assert.equal(bFailed.length, 1)
    assert.equal(bFailed[0].fields.errorKind, 'unknown', '不像稳定码的错误折成 unknown')
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
    assert.deepEqual(
      summary[0].fields,
      { total: 5, ok: 3, failed: 1, skipped: 1, durationMs: 60 },
      'a 已最新 + b 装完 + self 已最新 = ok 3；d 查失败 1；c 跳过 1；共 6 次传输调用 ×10ms',
    )
    const fields = summary[0].fields
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
    assert.equal(sum(both[1].fields), both[1].fields.total)
    assert.ok(both[1].fields.durationMs >= both[0].fields.durationMs, '时长是同一会话的累计真测量')

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
