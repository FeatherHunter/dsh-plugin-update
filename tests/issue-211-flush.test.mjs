/**
 * tests/issue-211-flush.test.mjs —— issue #211 AC-3：`flushUpdateLog(options?)` 有界冲刷。
 *
 * 公开 API（Lead 冻结，README 照此写）：
 *   flushUpdateLog(options?: { timeoutMs?: number }): Promise<{
 *     flushed: boolean   // 全部有界冲刷完成 && 没有失败 && 剩余待落盘为 0
 *     timedOut: boolean  // 是否因超时提前返回（true 时 flushed 必为 false）
 *     pending: number    // 尽力估计的仍未落盘行数（各 store getPendingCount 之和，取不到按 0）
 *     stores: number     // 本次参与冲刷的自建 store 数（= own-log 登记数；外部落点不算）
 *   }>
 *   - 缺省 timeoutMs = 1000（DEFAULT_FLUSH_UPDATE_LOG_TIMEOUT_MS）；非正数/非有限值回落缺省；
 *   - 永不抛错、不 reject（beforeExit 可挂）；没登记 store 时立即 resolve
 *     { flushed:true, timedOut:false, pending:0, stores:0 }；
 *   - 只冲刷 logSink=self 的自建落点，不碰外部落点；
 *   - 优先引擎的 flushNow()，没有退到 synced()，两者都没有视为「没有异步队列」直接完成。
 *
 * 这里用假 dsh-log 引擎（`__setOwnLogAcquireSeamsForTests` 测试缝）+ 临时目录，
 * 不建真实日志、不写真实家目录；真引擎的落盘行为由 log-kernel / log-health 覆盖。
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const log = await import('../dist/log/index.js')
const hostMod = await import('../dist/host.js')
const registry = await import('../dist/log/registry.js')

const { flushUpdateLog, DEFAULT_FLUSH_UPDATE_LOG_TIMEOUT_MS, __resetOwnLogRegistryForTests } = log
const { acquireOwnLog, describeOwnLogRegistry } = registry
const { __setOwnLogAcquireSeamsForTests } = registry

const tempRoots = []

function tempRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `dsh-update-flush-${tag}-`))
  tempRoots.push(root)
  return root
}

/**
 * 假 dsh-log 引擎：形状就是 HostLog 的写口子集（`log` 必须有，register 才认）。
 * flushNow / synced / getPendingCount 按需给，用来分辨「优先 flushNow」「退 synced」「引擎没有队列」三条线。
 */
function fakeEngine({ flushNow, synced, pending } = {}) {
  const calls = { flushNow: 0, synced: 0 }
  const store = { log: () => {} }
  if (flushNow !== undefined) {
    store.flushNow = async () => {
      calls.flushNow += 1
      return flushNow(calls)
    }
  }
  if (synced !== undefined) {
    store.synced = async () => {
      calls.synced += 1
      return synced(calls)
    }
  }
  if (pending !== undefined) store.getPendingCount = typeof pending === 'function' ? pending : () => pending
  return { store, calls }
}

/** 把一条假引擎接进 own-log 登记表（每个 root/namespace 一格，互不串）。 */
async function wireFake(namespace, engine, tag = 'one') {
  __setOwnLogAcquireSeamsForTests({
    loader: async () => ({ createNodeHostLog: async () => engine.store }),
    retryDelaysMs: [],
  })
  const got = await acquireOwnLog({ logsRoot: tempRoot(tag), namespace, prefix: 'wf' })
  assert.ok(got.sink, `假引擎应该接得进登记表（reason=${got.reason}）`)
  return got
}

/** 多条登记：loader 依次吐出各引擎（按 acquire 顺序）。 */
function installQueueLoader(engines) {
  const left = engines.slice()
  __setOwnLogAcquireSeamsForTests({
    loader: async () => ({
      createNodeHostLog: async () => {
        const engine = left.shift()
        if (!engine) throw new Error('假引擎队列空了')
        return engine.store
      },
    }),
    retryDelaysMs: [],
  })
}

async function acquireWith(root, namespace) {
  const got = await acquireOwnLog({ logsRoot: root, namespace, prefix: 'wf' })
  assert.ok(got.sink, `假引擎应该接得进登记表（${namespace}，reason=${got.reason}）`)
  return got
}

const elapsed = (started) => Date.now() - started

afterEach(() => {
  __resetOwnLogRegistryForTests()
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true })
})

describe('#211 flushUpdateLog：公开形状与空登记', () => {
  it('两个入口导出同一个函数，缺省超时是 1000ms', () => {
    assert.equal(typeof flushUpdateLog, 'function')
    assert.equal(hostMod.flushUpdateLog, flushUpdateLog, '主入口再导出的必须是同一个函数')
    assert.equal(DEFAULT_FLUSH_UPDATE_LOG_TIMEOUT_MS, 1000)
  })

  it('没有登记 store：立即回执空结果，不等满超时', async () => {
    const started = Date.now()
    const result = await flushUpdateLog()
    assert.deepEqual(result, { flushed: true, timedOut: false, pending: 0, stores: 0 })
    assert.ok(elapsed(started) < 200, '没登记时不该等超时')
  })

  it('非法 options 永不抛：undefined / null / 非数字 timeoutMs 都折成缺省', async () => {
    await assert.doesNotReject(() => flushUpdateLog(undefined))
    await assert.doesNotReject(() => flushUpdateLog(null))
    const result = await flushUpdateLog({ timeoutMs: 'not-a-number' })
    assert.deepEqual(result, { flushed: true, timedOut: false, pending: 0, stores: 0 })
  })
})

describe('#211 flushUpdateLog：三档冲刷路径', () => {
  it('优先用 flushNow()：完成后 flushed=true / pending=0 / stores=1', async () => {
    const engine = fakeEngine({ flushNow: async () => {}, synced: async () => {} })
    await wireFake('flush.priority', engine)
    const result = await flushUpdateLog()
    assert.deepEqual(result, { flushed: true, timedOut: false, pending: 0, stores: 1 })
    assert.equal(engine.calls.flushNow, 1, '有 flushNow 就不该退到 synced')
    assert.equal(engine.calls.synced, 0)
  })

  it('没有 flushNow 时退到 synced()', async () => {
    const engine = fakeEngine({ synced: async () => {} })
    await wireFake('flush.fallback', engine)
    const result = await flushUpdateLog()
    assert.deepEqual(result, { flushed: true, timedOut: false, pending: 0, stores: 1 })
    assert.equal(engine.calls.synced, 1)
  })

  it('两者都没有：当作没有异步队列，直接完成', async () => {
    const engine = fakeEngine()
    await wireFake('flush.none', engine)
    const result = await flushUpdateLog()
    assert.deepEqual(result, { flushed: true, timedOut: false, pending: 0, stores: 1 })
  })

  it('冲刷不动登记表：引用计数与登记格原样保留（释放仍归 releaseOwnLog）', async () => {
    const engine = fakeEngine({ flushNow: async () => {} })
    const got = await wireFake('flush.keep', engine)
    await flushUpdateLog()
    const registryView = describeOwnLogRegistry()
    assert.equal(registryView.size, 1)
    assert.equal(registryView.entries[0].refs, got.handle.refs, '冲刷只读快照，不扣引用')
  })
})

describe('#211 flushUpdateLog：pending 语义', () => {
  it('flush 完成后仍有排队行（getPendingCount>0）→ flushed=false，pending 如实报数', async () => {
    const engine = fakeEngine({ flushNow: async () => {}, pending: 2 })
    await wireFake('flush.pending', engine)
    const result = await flushUpdateLog()
    assert.deepEqual(result, { flushed: false, timedOut: false, pending: 2, stores: 1 })
  })

  it('getPendingCount 自己抛错不影响回执：pending 按 0 计', async () => {
    const engine = fakeEngine({
      flushNow: async () => {},
      pending: () => {
        throw new Error('pending boom')
      },
    })
    await wireFake('flush.pending-throw', engine)
    const result = await flushUpdateLog()
    assert.deepEqual(result, { flushed: true, timedOut: false, pending: 0, stores: 1 })
  })
})

describe('#211 flushUpdateLog：有界等待与永不抛', () => {
  it('引擎挂住 + timeoutMs:25 → 按时返回 timedOut=true、flushed=false、pending 如实', async () => {
    const engine = fakeEngine({ flushNow: () => new Promise(() => {}), pending: 7 })
    await wireFake('flush.hang', engine)
    const started = Date.now()
    const result = await flushUpdateLog({ timeoutMs: 25 })
    assert.equal(result.timedOut, true)
    assert.equal(result.flushed, false)
    assert.equal(result.pending, 7)
    assert.equal(result.stores, 1)
    assert.ok(elapsed(started) >= 20, '至少等满 timeoutMs')
    assert.ok(elapsed(started) < 1000, '超时后不许继续等')
  })

  it('缺省 timeoutMs 有界：挂住的引擎最多等约 1000ms 就返回', async () => {
    const engine = fakeEngine({ flushNow: () => new Promise(() => {}) })
    await wireFake('flush.hang-default', engine)
    const started = Date.now()
    const result = await flushUpdateLog()
    assert.equal(result.timedOut, true)
    assert.equal(result.flushed, false)
    assert.ok(elapsed(started) >= 900, '缺省等待接近 1000ms')
    assert.ok(elapsed(started) < 3000, '缺省等待必须是有界的')
  })

  it('引擎 flush 自己抛错：不 reject；flushed=false、timedOut=false', async () => {
    const engine = fakeEngine({
      flushNow: async () => {
        throw new Error('disk full')
      },
      pending: 1,
    })
    await wireFake('flush.reject', engine)
    const result = await flushUpdateLog()
    assert.deepEqual(result, { flushed: false, timedOut: false, pending: 1, stores: 1 })
  })

  it('多 store：一个正常、一个挂住 → 正常者被调用，超时只影响挂住者，pending 合计', async () => {
    const healthy = fakeEngine({ flushNow: async () => {} })
    const hanging = fakeEngine({ flushNow: () => new Promise(() => {}), pending: 5 })
    installQueueLoader([healthy, hanging])
    const root = tempRoot('multi')
    await acquireWith(root, 'flush.multi.a')
    await acquireWith(root, 'flush.multi.b')
    const started = Date.now()
    const result = await flushUpdateLog({ timeoutMs: 25 })
    assert.equal(result.stores, 2)
    assert.equal(result.timedOut, true)
    assert.equal(result.flushed, false)
    assert.equal(result.pending, 5)
    assert.equal(healthy.calls.flushNow, 1, '一个 store 挂住不许挡另一个被冲刷')
    assert.ok(elapsed(started) < 1000)
  })
})
