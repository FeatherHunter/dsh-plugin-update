/**
 * tests/batch-check-expired-backoff.test.mjs —— #269/205101：宿主重载换手窗口的 check-expired 有界退避重试。
 *
 * 真机现场（2026-11-02 12:53，run 269-20261102T205101，SUT dsh-plugin-update@0.18.39）：
 *   - 三包批量里 A 行安装成功触发宿主重载（12:53:30.522 三插件同时 update.wire.ready）；
 *   - B 首次提交 12:53:30.589 被 gate 拒（check-expired），12:53:30.610 当场重查成功、
 *     12:53:30.625 用新 checkId 重提，12:53:30.627 仍被 gate 拒——重查与提交落到了换手中的
 *     不同实例；旧实现只重试一次，于是 B/C 两行记 failed 但台账没有失败行（丢单观感）；
 *   - 对照 269-20261102T211934：重载后 220ms 重提即成功。凭证 TTL 是检查时刻起的秒级窗口，
 *     20ms 内不该过期，所以这是换手瞬态，不是凭证真过期。
 *
 * 修法（src/host/batch/phones.ts 的 defaultInstall）：把「重查+重提」1 次改成有界重试循环，
 * 最多 2 次重试（总提交 3 次），每次重试前 sleep(300) 让换手落定；每次重试照旧发
 * update.install.retry{reason:'check-expired', attempt:2|3, requestHash}；最终仍过期才如实失败。
 * 双 driver 并存的 fencing 不在本票范围（研究笔记的 known issue）。
 *
 * 本测试只走 dist 内部件 + 注入的电话 handler，不碰真机、不碰网络：
 *   1) 前 2 次提交 check-expired、第 3 次成功 → install 被调 3 次、最终 done、两条 retry 行 attempt=2/3；
 *   2) 3 次全拒 → 有界收手，failed(error=check-expired, stage=install)，不再多发提交；
 *   3) 首次即成功 → 一次提交、不重查（退避重试只在 check-expired 时发生）。
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_CACHE, defaultInstall } from '../dist/host/batch/phones.js'
import { primeUpdateEventTable } from '../dist/log/manifest.js'
import { bind, collector, rowsOf, unbindAll } from './helpers/batch-log-harness.mjs'

const PLUGIN_ID = 'plugin-a'
const SPEC = { key: 'a', title: '夹具 A', packageName: 'pkg-a', prefix: 'p-a', pluginId: PLUGIN_ID }
const REQUEST_ID = 'batch:session-269:a'
const TARGET_VERSION = '2.0.0'
const PHONE_NAMES = {
  updateCheck: 'p-a.updateCheck',
  updateInstall: 'p-a.updateInstall',
  updateStatus: 'p-a.updateStatus',
}

function makeRuntime({ rejectFirst = 0, rejectAll = false } = {}) {
  const calls = { installs: [], checks: 0 }
  const rt = {
    spec: SPEC,
    config: {},
    resolved: { installTimeoutMs: 5000 },
    host: { phoneNames: PHONE_NAMES, handlers: {} },
    pluginId: PLUGIN_ID,
    homeDir: 'C:/fake/home',
    profileDir: 'C:/fake/profile',
    // defaultInstall 真路径只用 rt.check + 电话 handler；rt.install 是驱动器的注入缝，这里不该被用。
    install: async () => {
      throw new Error('defaultInstall 不应调用 rt.install')
    },
    check: async () => {
      calls.checks += 1
      rt.receipt = { checkId: 'check-' + calls.checks, version: TARGET_VERSION }
      return { kind: 'update', version: TARGET_VERSION }
    },
    skipPorts: null,
    cache: { ...EMPTY_CACHE },
    // 跨重启续跑只剩旧凭证：初始 receipt 来自重载前那次 check。
    receipt: { checkId: 'check-0', version: TARGET_VERSION },
    now: () => 1_000_000,
    pollMs: 5,
  }
  rt.host.handlers[PHONE_NAMES.updateInstall] = async (args) => {
    calls.installs.push(args.checkId)
    if (rejectAll || calls.installs.length <= rejectFirst) {
      return { ok: false, error: 'check-expired', errorKind: 'check-expired' }
    }
    return {
      ok: true,
      snapshot: {
        job: { state: 'completed', targetVersion: TARGET_VERSION },
        installedVersion: TARGET_VERSION,
        latestVersion: TARGET_VERSION,
      },
      queue: { position: null },
    }
  }
  return { rt, calls }
}

beforeEach(() => {
  primeUpdateEventTable()
})

afterEach(() => {
  unbindAll()
})

describe('#269/205101 check-expired 有界退避重试', () => {
  it('前两次提交被换手窗口拒、第三次成功：共 3 次提交，最终 done，retry 行 attempt=2/3', async () => {
    const store = collector()
    bind(PLUGIN_ID, store.sink)
    const { rt, calls } = makeRuntime({ rejectFirst: 2 })

    const outcome = await defaultInstall(rt, 'a', SPEC, REQUEST_ID)

    assert.deepEqual(outcome, { kind: 'done', restartRequired: false })
    assert.deepEqual(calls.installs, ['check-0', 'check-1', 'check-2'], '每次重试都换用重查后的新 checkId')
    assert.equal(calls.checks, 2, '两次重试各重查一次')
    const retries = rowsOf(store, 'update.install.retry')
    assert.equal(retries.length, 2, '每次重试留一行（不是静默）')
    assert.deepEqual(retries.map((row) => row.fields.attempt), [2, 3], 'attempt 递增到 3')
    for (const row of retries) {
      assert.equal(row.fields.reason, 'check-expired')
      assert.match(row.fields.requestHash, /^[0-9a-f]{8}$/, '请求编号只落指纹')
      assert.deepEqual(Object.keys(row.fields).sort(), ['attempt', 'reason', 'requestHash'])
    }
  })

  it('三次全拒：有界收手，最终 failed(error=check-expired, stage=install)，不再多发提交', async () => {
    const store = collector()
    bind(PLUGIN_ID, store.sink)
    const { rt, calls } = makeRuntime({ rejectAll: true })

    const outcome = await defaultInstall(rt, 'a', SPEC, REQUEST_ID)

    assert.deepEqual(outcome, { kind: 'failed', error: 'check-expired', stage: 'install' })
    assert.equal(calls.installs.length, 3, '最多 2 次重试、总提交 3 次，绝不无限重试')
    assert.equal(calls.checks, 2)
    assert.deepEqual(rowsOf(store, 'update.install.retry').map((row) => row.fields.attempt), [2, 3])
  })

  it('首次即成功：一次提交、不重查、不发 retry 行', async () => {
    const store = collector()
    bind(PLUGIN_ID, store.sink)
    const { rt, calls } = makeRuntime({ rejectFirst: 0 })

    const outcome = await defaultInstall(rt, 'a', SPEC, REQUEST_ID)

    assert.deepEqual(outcome, { kind: 'done', restartRequired: false })
    assert.deepEqual(calls.installs, ['check-0'])
    assert.equal(calls.checks, 0)
    assert.equal(rowsOf(store, 'update.install.retry').length, 0)
  })
})
