/**
 * tests/batch-resume-current.test.mjs —— #284 真机暴露：续跑行重查 remitter 已是目标版时误判 check-expired。
 *
 * 真机现场（2026-11-03 18:11，run 284-20261103T181522，M2 第三幕）：
 *   - fxa-c 行在宿主换手前是 ready+targetVersion=0.0.2；换手后 driver 直接进安装（跳过查），
 *     但 receipt 已随旧宿主丢失，defaultInstall 先重查；
 *   - 此时 fxb 批量已把 c 装到 0.0.2，重查返回 current（latest==installed==0.0.2）；
 *   - 旧实现把非 update 结论一律当 check-expired 失败（phones.ts 原 :354-360），
 *     c 行被记 failed(check-expired, stage=check) —— 行已达成目标却丢行，违反续跑 AC。
 *
 * 修法：defaultInstall 的两处重查（首次缺 receipt / check-expired 退避重查）里，
 * again.kind === current|done 且 installedVersion 已满足 targetVersion 时按 done 收尾
 * （current 回 restartRequired:false，done 原样透传）；目标版未被满足时保持原诚实失败。
 *
 * 本测试只走 dist 内部件 + 注入电话 handler，不碰真机、不碰网络。
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_CACHE, defaultInstall } from '../dist/host/batch/phones.js'
import { primeUpdateEventTable } from '../dist/log/manifest.js'
import { bind, collector, rowsOf, unbindAll } from './helpers/batch-log-harness.mjs'

const PLUGIN_ID = 'plugin-a'
const SPEC = { key: 'a', title: '夹具 A', packageName: 'pkg-a', prefix: 'p-a', pluginId: PLUGIN_ID }
const REQUEST_ID = 'batch:session-284:a'
const TARGET_VERSION = '0.0.2'
const PHONE_NAMES = {
  updateCheck: 'p-a.updateCheck',
  updateInstall: 'p-a.updateInstall',
  updateStatus: 'p-a.updateStatus',
}

/** 造一个「跨重启只剩 ready 行、receipt 已丢」的目标运行期零件；check 由用例注入。 */
function makeRuntime({ checkOutcome, installedVersion = null, receipt = null, rejectInstall = false } = {}) {
  const calls = { installs: [], checks: 0 }
  const rt = {
    spec: SPEC,
    config: {},
    resolved: { installTimeoutMs: 5000 },
    host: { phoneNames: PHONE_NAMES, handlers: {} },
    pluginId: PLUGIN_ID,
    homeDir: 'C:/fake/home',
    profileDir: 'C:/fake/profile',
    install: async () => {
      throw new Error('defaultInstall 不应调用 rt.install')
    },
    check: async () => {
      calls.checks += 1
      // 与 callPhone 一致：成功回包把快照收进缓存（satisfiedByRecheck 读 installedVersion 的落点）。
      rt.cache = { ...rt.cache, snapshot: { installedVersion }, error: null }
      if (checkOutcome.kind === 'update') rt.receipt = { checkId: 'check-' + calls.checks, version: checkOutcome.version }
      return checkOutcome
    },
    skipPorts: null,
    cache: { ...EMPTY_CACHE },
    receipt,
    now: () => 1_000_000,
    pollMs: 5,
  }
  rt.host.handlers[PHONE_NAMES.updateInstall] = async (args) => {
    calls.installs.push(args.checkId)
    if (rejectInstall) return { ok: false, error: 'check-expired', errorKind: 'check-expired' }
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

describe('#284 续跑行重查已达成目标时收 done（不误判 check-expired）', () => {
  it('重启后无 receipt、重查 current 且 installedVersion=目标版 → done(restartRequired:false)，不提交安装', async () => {
    const store = collector()
    bind(PLUGIN_ID, store.sink)
    const { rt, calls } = makeRuntime({ checkOutcome: { kind: 'current' }, installedVersion: TARGET_VERSION })

    const outcome = await defaultInstall(rt, 'a', SPEC, REQUEST_ID, TARGET_VERSION)

    assert.deepEqual(outcome, { kind: 'done', restartRequired: false })
    assert.equal(calls.checks, 1, '只重查一次')
    assert.equal(calls.installs.length, 0, '目标已达成，不再提交安装')
    assert.equal(rowsOf(store, 'update.install.retry').length, 0)
  })

  it('重查 done 且 installedVersion=目标版 → 原样透传 done（保留 restartRequired:true）', async () => {
    const store = collector()
    bind(PLUGIN_ID, store.sink)
    const { rt, calls } = makeRuntime({
      checkOutcome: { kind: 'done', version: TARGET_VERSION, restartRequired: true },
      installedVersion: TARGET_VERSION,
    })

    const outcome = await defaultInstall(rt, 'a', SPEC, REQUEST_ID, TARGET_VERSION)

    assert.deepEqual(outcome, { kind: 'done', version: TARGET_VERSION, restartRequired: true })
    assert.equal(calls.installs.length, 0)
  })

  it('对照：重查 current 但 installedVersion 低于目标版 → 仍诚实失败 failed(check-expired, stage=check)', async () => {
    const store = collector()
    bind(PLUGIN_ID, store.sink)
    const { rt, calls } = makeRuntime({ checkOutcome: { kind: 'current' }, installedVersion: '0.0.1' })

    const outcome = await defaultInstall(rt, 'a', SPEC, REQUEST_ID, TARGET_VERSION)

    assert.deepEqual(outcome, { kind: 'failed', error: 'check-expired', stage: 'check' })
    assert.equal(calls.installs.length, 0, '目标版没被满足，不许提交')
  })

  it('对照：重查 current 但读不到 installedVersion → 不吞真失败，仍 failed', async () => {
    const { rt } = makeRuntime({ checkOutcome: { kind: 'current' }, installedVersion: null })

    const outcome = await defaultInstall(rt, 'a', SPEC, REQUEST_ID, TARGET_VERSION)

    assert.deepEqual(outcome, { kind: 'failed', error: 'check-expired', stage: 'check' })
  })

  it('退避重查路径：首次提交 check-expired、退避后重查 current 已达目标 → done，安装只提交 1 次', async () => {
    const store = collector()
    bind(PLUGIN_ID, store.sink)
    const { rt, calls } = makeRuntime({
      checkOutcome: { kind: 'current' },
      installedVersion: TARGET_VERSION,
      receipt: { checkId: 'check-before-restart', version: TARGET_VERSION },
      rejectInstall: true,
    })

    const outcome = await defaultInstall(rt, 'a', SPEC, REQUEST_ID, TARGET_VERSION)

    assert.deepEqual(outcome, { kind: 'done', restartRequired: false })
    assert.deepEqual(calls.installs, ['check-before-restart'], '只提交一次旧凭证，退避后不再提交')
    assert.equal(calls.checks, 1, '退避里重查一次即收 done')
  })
})
