/**
 * tests/issue-156-fallback.test.mjs —— #156：合规版降级决议与候选安装（核心流）。
 *
 * 只测外部行为：假源挂载核心，走公开的 checkFallback/install/status。
 * 决议口径以纯函数真值表（tests/compliant-version.test.mjs）为准：
 * kind 缺省即 minimum-release-age；blame 只认 target（面板只传门里认出的 target，
 * 缺失或胡写按 unknown 认怂 abstain——服务层不替调用方猜"拦的是谁"，B 类 other-package
 * 同理 abstain：降级装一个"没被拦的包"的旧版躲不掉别人的窗口）。
 * 时间全相对 now 冻结：1.66.28 发布 1 小时（门限内被拦），1.66.27 发布 25 小时（合规候选）。
 * 1. 决议 → downgrade-available + 候选 '1.66.27' + 第二槽凭证；
 * 2. 凭第二槽装候选 → 任务与执行器都指向候选版，落定成功；
 * 3. 同一凭证装没被绑定的 '1.66.26' → check-expired（不认任意旧版）；
 * 4. 决议后走一次普通 check() → 第二槽清空，旧凭证装候选同样过期（决议不跨检查复用）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateCore, __resetFallbackSlots } from '../dist/service.js'
import { resolveCompliantVersion } from '../dist/compliant-version.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'dsh-demo-widget'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'D'.repeat(86) + '=='
const NOW = 2_000_000_000_000
const HOUR = 3_600_000

const PUBLISHED = {
  '1.66.26': new Date(NOW - 30 * HOUR).toISOString(),
  '1.66.27': new Date(NOW - 25 * HOUR).toISOString(),
  '1.66.28': new Date(NOW - 1 * HOUR).toISOString(),
}

function versionBody(version) {
  return JSON.stringify({
    name: TARGET,
    version,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`, integrity: INTEGRITY },
  })
}

function fakeFetch(extraTimes = {}) {
  return async (url) => {
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}`) {
      return {
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            name: TARGET,
            'dist-tags': { latest: '1.66.28' },
            time: { ...PUBLISHED, ...extraTimes, created: PUBLISHED['1.66.26'], modified: PUBLISHED['1.66.28'] },
          }),
      }
    }
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}/latest`) return { ok: true, headers: { get: () => null }, text: async () => versionBody('1.66.28') }
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}/1.66.28`) return { ok: true, headers: { get: () => null }, text: async () => versionBody('1.66.28') }
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}/1.66.27`) return { ok: true, headers: { get: () => null }, text: async () => versionBody('1.66.27') }
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}/1.66.26`) return { ok: true, headers: { get: () => null }, text: async () => versionBody('1.66.26') }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' }
  }
}

function memoryJobStore() {
  let job = null
  let locked = null
  return {
    readJob: async () => job,
    writeJob: async (value) => {
      job = value
    },
    tryAcquireLock: async (id) => {
      if (locked !== null) return false
      locked = id
      return true
    },
    releaseLock: async (id) => {
      if (locked === id) locked = null
    },
    backupJob: async () => {},
  }
}

function basePorts({ store, runInstall, installedVersionRef, fetchImpl }) {
  return {
    readRunningVersion: () => '1.0.0',
    readInstalled: async () => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: null,
      profileDir: null,
      installedVersion: installedVersionRef.current,
      packageValid: true,
      sourceInstall: false,
      blockedReason: null,
      installationKey: 'key-1',
      eligible: true,
    }),
    fetchImpl: fetchImpl ?? fakeFetch(),
    now: () => NOW,
    randomId: (() => {
      let n = 0
      return () => `id-${(n += 1)}`
    })(),
    nodeVersion: '22.0.0',
    readJob: store.readJob,
    writeJob: store.writeJob,
    tryAcquireLock: store.tryAcquireLock,
    releaseLock: store.releaseLock,
    backupJob: store.backupJob,
    runInstall,
    resolveCompliantVersion,
    targetPackageName: TARGET,
  }
}

function deferredRunInstall() {
  let release = null
  const promise = new Promise((resolve) => {
    release = resolve
  })
  let seenArgs = null
  const runInstall = async (args) => {
    seenArgs = args
    await promise
  }
  return { runInstall, release, seen: () => seenArgs }
}

async function waitFor(core, pred, timeoutMs = 2000) {
  const start = Date.now()
  for (;;) {
    const snap = await core.status()
    if (pred(snap)) return snap
    if (Date.now() - start > timeoutMs) throw new Error('等待后台落定超时：' + JSON.stringify(snap.job))
    await new Promise((r) => setTimeout(r, 10))
  }
}

// 主包自己太新被拦（blame 必须显式 target：被拦的正是要装的包，降级才躲得掉）。
const FALLBACK_INPUT = { targetVersion: '1.66.28', windowMs: 24 * HOUR, windowSource: 'message', blame: 'target' }

async function setup({ fetchImpl } = {}) {
  const store = memoryJobStore()
  const installedVersionRef = { current: '1.0.0' }
  const gate = deferredRunInstall()
  const core = createUpdateCore(basePorts({ store, runInstall: gate.runInstall, installedVersionRef, fetchImpl }))
  return { store, installedVersionRef, gate, core }
}

describe('合规版降级决议与候选安装（#156）', () => {
  // 凭证槽是模块级状态（按安装指纹寻址，见 src/service.ts 的 FallbackSlot 注释）：
  // 用例之间必须清空，否则上一个用例留下的候选会让下一个用例"假绿"。
  beforeEach(() => {
    __resetFallbackSlots()
  })

  it('最新版被拦、老版有合规 → downgrade-available + 候选 + 第二槽凭证', async () => {
    const { core } = await setup()
    const result = await core.checkFallback(FALLBACK_INPUT)
    assert.equal(result.verdict.kind, 'downgrade-available')
    assert.equal(result.verdict.version, '1.66.27')
    assert.equal(result.verdict.targetVersion, '1.66.28')
    assert.equal(result.candidate, '1.66.27')
    assert.ok(result.receipt && result.receipt.checkId, '有候选即有凭证')
  })

  it('凭第二槽装候选：任务与执行器都指向候选版，落定成功', async () => {
    const { core, gate, installedVersionRef } = await setup()
    const decided = await core.checkFallback(FALLBACK_INPUT)
    const snap = await core.install({
      checkId: decided.receipt.checkId,
      requestId: 'req-156-ok',
      version: decided.candidate,
    })
    assert.equal(snap.job && snap.job.state, 'installing')
    assert.equal(snap.job && snap.job.targetVersion, '1.66.27')
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(gate.seen(), 'runInstall 应已被后台触发')
    assert.equal(gate.seen().version, '1.66.27')
    installedVersionRef.current = '1.66.27'
    gate.release()
    const done = await waitFor(core, (s) => s.job && (s.job.state === 'restart-required' || s.job.state === 'completed'))
    assert.equal(done.job.targetVersion, '1.66.27')
  })

  it('同一凭证装没被绑定的旧版：check-expired，不认任意旧版', async () => {
    const { core } = await setup()
    const decided = await core.checkFallback(FALLBACK_INPUT)
    await assert.rejects(
      () => core.install({ checkId: decided.receipt.checkId, requestId: 'req-156-wrong', version: '1.66.26' }),
      /check-expired/
    )
  })

  it('决议后走一次普通检查：第二槽清空，旧凭证装候选同样过期', async () => {
    const { core } = await setup()
    const decided = await core.checkFallback(FALLBACK_INPUT)
    const checked = await core.check()
    assert.equal(checked.snapshot.latestVersion, '1.66.28')
    await assert.rejects(
      () => core.install({ checkId: decided.receipt.checkId, requestId: 'req-156-stale', version: '1.66.27' }),
      /check-expired/
    )
  })

  it('B 类归因（other-package）天然 abstain：降级装没被拦的包躲不掉别人的窗口', async () => {
    const { core } = await setup()
    const result = await core.checkFallback({ ...FALLBACK_INPUT, blame: 'other-package' })
    assert.equal(result.verdict.kind, 'abstain')
    assert.equal(result.candidate, null)
    assert.equal(result.receipt, null)
  })

  // M2（2026-10-17 对抗审查）：门限已经过了的那一刻，诚实答案是"现在直接装最新版"。
  // 决议本来就是 ok-now + version=最新版，三个入口也都认 ok-now；从前只有服务侧不给凭证，
  // 于是最该说"装最新版"的时刻反而弹"不可用"——而同一下普通重试却能成功（自相矛盾）。
  it('门限已过（ok-now）：候选就是最新版自己，照样发凭证，点下去装的就是它（M2）', async () => {
    const { core, gate, installedVersionRef } = await setup({
      fetchImpl: fakeFetch({ '1.66.28': new Date(NOW - 25 * HOUR).toISOString() }),
    })
    const decided = await core.checkFallback(FALLBACK_INPUT)
    assert.equal(decided.verdict.kind, 'ok-now')
    assert.equal(decided.verdict.version, '1.66.28', '决议点名的就是最新版')
    assert.equal(decided.candidate, '1.66.28', '候选＝最新版自己（不是降级候选）')
    assert.ok(decided.receipt && decided.receipt.checkId, 'ok-now 也发凭证')

    const snap = await core.install({
      checkId: decided.receipt.checkId,
      requestId: 'req-156-oknow',
      version: decided.candidate,
    })
    assert.equal(snap.job && snap.job.state, 'installing')
    assert.equal(snap.job && snap.job.targetVersion, '1.66.28', '点名哪版装哪版：绝不偷偷换成老版')
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(gate.seen(), 'runInstall 应已被后台触发')
    assert.equal(gate.seen().version, '1.66.28')
    installedVersionRef.current = '1.66.28'
    gate.release()
    const done = await waitFor(core, (s) => s.job && (s.job.state === 'restart-required' || s.job.state === 'completed'))
    assert.equal(done.job.targetVersion, '1.66.28')
  })

  // M3（2026-10-17 对抗审查）：凭证最长活十分钟。确认时必须拿同一批输入重跑决议——
  // "当时可装"不等于"现在还是最新可装"；否则会用一个过时的结论装上一个不是最新可装的版本。
  it('确认时远端已前进（新候选不同）：check-expired，一个字节都不许装（M3）', async () => {
    const store = memoryJobStore()
    const installedVersionRef = { current: '1.0.0' }
    const gate = deferredRunInstall()
    const base = fakeFetch()
    let phase = 'decide'
    const fetchImpl = async (url, ...rest) => {
      // 决议之后、确认之前：远端前进到 1.66.29（已满门限）——此刻"最新可装"不再是 1.66.27。
      if (phase === 'confirm' && url === `${REGISTRY}${encodeURIComponent(TARGET)}`) {
        return {
          ok: true,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              name: TARGET,
              'dist-tags': { latest: '1.66.29' },
              time: {
                '1.66.27': PUBLISHED['1.66.27'],
                '1.66.28': PUBLISHED['1.66.28'],
                '1.66.29': new Date(NOW - 30 * HOUR).toISOString(),
                created: PUBLISHED['1.66.26'],
                modified: new Date(NOW - 30 * HOUR).toISOString(),
              },
            }),
        }
      }
      if (url === `${REGISTRY}${encodeURIComponent(TARGET)}/1.66.29`) {
        return { ok: true, headers: { get: () => null }, text: async () => versionBody('1.66.29') }
      }
      return base(url, ...rest)
    }
    const core = createUpdateCore(basePorts({ store, runInstall: gate.runInstall, installedVersionRef, fetchImpl }))
    const decided = await core.checkFallback(FALLBACK_INPUT)
    assert.equal(decided.candidate, '1.66.27')
    phase = 'confirm'
    await assert.rejects(
      () => core.install({ checkId: decided.receipt.checkId, requestId: 'req-156-m3', version: '1.66.27' }),
      /check-expired/,
    )
    assert.equal(gate.seen(), null, '复核没过：执行器一次都不许被叫到')
  })

  it('确认时复核取数失败：拒装（宁可诚实失败，不装没复核过的版本）（M3）', async () => {
    const store = memoryJobStore()
    const installedVersionRef = { current: '1.0.0' }
    const gate = deferredRunInstall()
    const base = fakeFetch()
    let phase = 'decide'
    const fetchImpl = async (url, ...rest) => {
      if (phase === 'confirm' && url === `${REGISTRY}${encodeURIComponent(TARGET)}`) throw new Error('registry-unreachable')
      return base(url, ...rest)
    }
    const core = createUpdateCore(basePorts({ store, runInstall: gate.runInstall, installedVersionRef, fetchImpl }))
    const decided = await core.checkFallback(FALLBACK_INPUT)
    phase = 'confirm'
    await assert.rejects(() => core.install({ checkId: decided.receipt.checkId, requestId: 'req-156-m3-net', version: decided.candidate }))
    assert.equal(gate.seen(), null, '取不到数就不装，不复用旧结论')
  })

  it('归因缺失或胡写按 unknown 认怂：abstain + 零联网（服务层不替调用方猜拦的是谁）', async () => {
    const store = memoryJobStore()
    const installedVersionRef = { current: '1.0.0' }
    const gate = deferredRunInstall()
    const ports = basePorts({ store, runInstall: gate.runInstall, installedVersionRef })
    let fetches = 0
    const inner = ports.fetchImpl
    ports.fetchImpl = async (...args) => {
      fetches += 1
      return inner(...args)
    }
    const core = createUpdateCore(ports)
    for (const blame of [undefined, 'garbage']) {
      const result = await core.checkFallback({ ...FALLBACK_INPUT, blame })
      assert.equal(result.verdict.kind, 'abstain', 'blame=' + String(blame))
      assert.equal(result.candidate, null)
      assert.equal(result.receipt, null)
    }
    assert.equal(fetches, 0, '认怂走早退，不花一次联网')
  })
})

describe('合规版决议电话接线（#156）', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
    __resetFallbackSlots()
  })

  it('wf.updateCheckFallback：决议随 snapshot 回，凭证随 receipt 回', async () => {
    const store = memoryJobStore()
    const fires = []
    const host = createHostUpdate(
      {
        logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
        readerOverrides: {
          runningVersion: '1.0.0',
          profileDir: 'C:\\fake\\profile',
          profileName: 'web',
          homeDir: 'C:\\fake\\home',
          fetchImpl: fakeFetch(),
          now: () => NOW,
          randomId: (() => {
            let n = 0
            return () => `id-${(n += 1)}`
          })(),
          nodeVersion: '22.0.0',
          environmentKind: 'cli',
          targetPackageName: TARGET,
          readInstalled: async () => ({
            profileName: 'web',
            environmentKind: 'cli',
            homeDir: null,
            profileDir: null,
            installedVersion: '1.0.0',
            packageValid: true,
            sourceInstall: false,
            blockedReason: null,
            installationKey: 'key-1',
            eligible: true,
          }),
          readJob: store.readJob,
          writeJob: store.writeJob,
          tryAcquireLock: store.tryAcquireLock,
          releaseLock: store.releaseLock,
          backupJob: store.backupJob,
          runInstall: async () => {},
        },
      },
      { pluginId: TARGET }
    )
    assert.equal(host.phoneNames.updateCheckFallback, 'wf.updateCheckFallback')
    const out = await host.handlers['wf.updateCheckFallback']({
      kind: 'minimum-release-age',
      blame: 'target',
      targetVersion: '1.66.28',
      windowMs: 24 * HOUR,
      windowSource: 'message',
    })
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.verdict.kind, 'downgrade-available')
    assert.equal(out.snapshot.candidate, '1.66.27')
    assert.ok(out.receipt && typeof out.receipt.checkId === 'string')
  })
})
