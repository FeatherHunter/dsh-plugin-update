/**
 * tests/background.test.mjs —— 后台安装不中断（issue #14）。
 *
 * 只测外部行为：经公开的 status/check/install 三方法断言
 * “关面板不中断、重开恢复、仅进程关才停、宿主侧执行归属”。
 * 网络、落盘、执行全用内存假件，不碰真机。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateCore } from '../dist/service.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const RELEASE_VERSION = '2.0.0'
const INTEGRITY = 'sha512-' + 'C'.repeat(86) + '=='

function releaseBody() {
  return JSON.stringify({
    name: TARGET,
    version: RELEASE_VERSION,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${RELEASE_VERSION}.tgz`, integrity: INTEGRITY },
  })
}

function fakeFetch() {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(TARGET)}/latest`)
    return { ok: true, headers: { get: () => null }, text: async () => releaseBody() }
  }
}

/** 可控执行器：deferred 让测试决定安装何时落定，模拟“面板已关、宿主还在跑”。 */
function deferredRunInstall(hooks = {}) {
  let release = null
  const promise = new Promise((resolve) => {
    release = resolve
  })
  let seenArgs = null
  const runInstall = async (args) => {
    seenArgs = args
    if (typeof hooks.onStart === 'function') hooks.onStart(args)
    await promise
    if (typeof hooks.onEnd === 'function') hooks.onEnd()
  }
  return { runInstall, release, seen: () => seenArgs }
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
    peek: () => job,
  }
}

function basePorts({ store, runInstall, installedVersionRef }) {
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
    fetchImpl: fakeFetch(),
    now: () => 1_000_000,
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
  }
}

async function checkAndInstall(core) {
  const checked = await core.check()
  assert.equal(checked.snapshot.canInstall, true)
  assert.ok(checked.receipt && checked.receipt.checkId)
  const snap = await core.install({ checkId: checked.receipt.checkId, requestId: 'req-14' })
  return { snap, checkId: checked.receipt.checkId }
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

describe('后台安装不中断（#14）', () => {
  it('关面板不中断：install 落盘即返，执行在后台继续（调用方不干等）', async () => {
    const store = memoryJobStore()
    const installedVersionRef = { current: '1.0.0' }
    const gate = deferredRunInstall()
    const core = createUpdateCore(basePorts({ store, runInstall: gate.runInstall, installedVersionRef }))

    const { snap } = await checkAndInstall(core)
    // 落盘即返：install 返回时执行器仍在跑（deferred 未放行）。
    assert.equal(snap.job && snap.job.state, 'installing')
    assert.equal(snap.job && snap.job.targetVersion, RELEASE_VERSION)
    // 执行归属在宿主侧：核心把版本/范围/种类交给了宿主注入的执行器。
    // runInstall 是异步后台跑的，这里给一个微任务让它先被调用到。
    await new Promise((r) => setTimeout(r, 10))
    const seen = gate.seen()
    assert.ok(seen, 'runInstall 应已被后台触发')
    assert.equal(seen.version, RELEASE_VERSION)
    assert.equal(seen.profileName, 'web')
    assert.equal(seen.environmentKind, 'cli')

    // 关面板 = 中间不再轮询：直接放行执行，模拟磁盘已换成新版。
    installedVersionRef.current = RELEASE_VERSION
    gate.release()
    const done = await waitFor(core, (s) => s.job && (s.job.state === 'restart-required' || s.job.state === 'completed'))
    assert.equal(done.job.targetVersion, RELEASE_VERSION)
  })

  it('面板重开恢复进度：落盘后立刻 status 即见同一任务，后台落定后重查即见终态', async () => {
    const store = memoryJobStore()
    const installedVersionRef = { current: '1.0.0' }
    const gate = deferredRunInstall()
    const core = createUpdateCore(basePorts({ store, runInstall: gate.runInstall, installedVersionRef }))

    const { snap } = await checkAndInstall(core)
    const jobId = snap.job.id
    // 重开即恢复（1s 内判据在实现侧体现为“同 tick 可读”，这里断言立刻可见同一任务）。
    const reopened = await core.status()
    assert.equal(reopened.job && reopened.job.id, jobId)
    assert.equal(reopened.job && reopened.job.state, 'installing')

    installedVersionRef.current = RELEASE_VERSION
    gate.release()
    const final = await waitFor(core, (s) => s.job && s.job.state !== 'installing')
    assert.equal(final.job.id, jobId)
    assert.ok(final.job.state === 'restart-required' || final.job.state === 'completed')
  })

  it('仅进程关才停：同进程不断言中断，新进程（active 丢失）才判 recovery-required', async () => {
    const store = memoryJobStore()
    const installedVersionRef = { current: '1.0.0' }
    // 永不落定的执行器：模拟进程崩溃前抛下半截任务。
    const gate = deferredRunInstall()
    const coreA = createUpdateCore(basePorts({ store, runInstall: gate.runInstall, installedVersionRef }))
    const { snap } = await checkAndInstall(coreA)
    assert.equal(snap.job.state, 'installing')

    // 同进程（activeJobId 仍在）：关面板再重开也不判中断。
    const sameProcess = await coreA.status()
    assert.equal(sameProcess.job.state, 'installing')

    // 新进程：同一份落盘、新的核心实例（activeJobId 归零），半截任务判中断。
    // 判据看任务本身（state/message）：blockedReason 只在“磁盘与运行版已分叉”时才派生，
    // 半截抛下时两者仍一致（1.0.0==1.0.0）属正常——重查一次即可重装。
    const coreB = createUpdateCore(basePorts({ store, runInstall: async () => {}, installedVersionRef }))
    const healed = await coreB.status()
    assert.equal(healed.job.state, 'interrupted')
    assert.equal(healed.job.message, 'recovery-required')
  })
})
