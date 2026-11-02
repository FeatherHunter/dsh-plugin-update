/**
 * tests/reader-rotation-inflight.test.mjs —— #266 真机暴露的产品 BUG 回归：读取器单例换代不得误判同进程在飞任务。
 *
 * 现场（真机 run 266-20261102T021151）：批量安装 A/B/C 时，exec 换包瞬间目标包清单版本变化，
 * host/capabilities.ts 的 getSharedReader 按 runningVersion 缓存而新建 reader；新实例 activeJobId=null，
 * healJob 把磁盘上仍 installing/verifying 的同进程任务判成「上一个进程世代遗留」→ 合成
 * interrupted/recovery-required；批量的 settleInstall 读到这一瞬就把该家记 failed，尽管 exec 随后完成。
 * 修法：同一使用范围（缓存键除 runningVersion 外全同）且旧实例仍握着在飞任务时，先复用旧实例。
 *
 * 断言口径：
 *  1) 换包瞬间（在飞）再取 reader：必须是旧实例、job 仍是 installing，绝不出现 interrupted/recovery-required。
 *  2) 任务收尾后：换代恢复（拿到新实例，runningVersion 用新的），job 是 completed/restart-required，不是 interrupted。
 *  3) 反向不回归：真·进程重启（单例复位）后，磁盘上遗留的 installing 任务仍必须诚实报 interrupted/recovery-required。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSharedReader, resetSharedUpdateReaderState } from '../dist/host/capabilities.js'
import { resolveUpdateConfig } from '../dist/shared/config.js'

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
    writeRaw: async (value) => {
      job = value
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tmpRoots = []

async function makeScope() {
  const root = await mkdtemp(join(tmpdir(), 'dpu-266-reader-'))
  tmpRoots.push(root)
  const home = join(root, 'home')
  const profile = join(root, 'profile')
  const pkgDir = join(root, 'target-pkg')
  await mkdir(profile, { recursive: true })
  await mkdir(pkgDir, { recursive: true })
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: TARGET, version: '1.0.0', main: 'index.js', description: 'fake target for #266 regression' })
  )
  return { root, home, profile, pkgDir }
}

function baseOverrides(scope, store, refs, gate) {
  return {
    env: {},
    osHome: scope.root,
    homeDir: scope.home,
    profileDir: scope.profile,
    profileName: 'web',
    targetPackageDir: scope.pkgDir,
    fetchImpl: fakeFetch(),
    now: () => 1_000_000,
    randomId: (() => {
      let n = 0
      return () => `id-266-${(n += 1)}`
    })(),
    nodeVersion: '22.0.0',
    readInstalled: async () => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: null,
      profileDir: null,
      installed: refs.installedVersion !== null,
      installedVersion: refs.installedVersion,
      packageValid: true,
      sourceInstall: false,
      blockedReason: null,
      registered: true,
      installationKey: 'key-266',
      eligible: true,
    }),
    readJob: store.readJob,
    writeJob: store.writeJob,
    tryAcquireLock: store.tryAcquireLock,
    releaseLock: store.releaseLock,
    backupJob: store.backupJob,
    runInstall: async (args) => {
      await gate.promise
      refs.installedVersion = args.version
    },
  }
}

function readerOverrides(scope, store, refs, gate, runningVersion) {
  return { ...baseOverrides(scope, store, refs, gate), runningVersion }
}

async function waitFor(fn, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

describe('#266：读取器单例换代不误判同进程在飞任务', () => {
  beforeEach(() => {
    resetSharedUpdateReaderState()
  })

  it('换包瞬间复用旧实例（job 仍 installing），收尾后再换代（不出现 interrupted）', async () => {
    const scope = await makeScope()
    const store = memoryJobStore()
    const refs = { installedVersion: '1.0.0' }
    const gate = deferred()
    const config = resolveUpdateConfig({ pluginId: 'fixture-a', prefix: 'fxa', targetPackageName: TARGET })

    const reader1 = await getSharedReader('fixture-a', config, readerOverrides(scope, store, refs, gate, '1.0.0'))
    const checked = await reader1.check()
    assert.equal(checked.snapshot.canInstall, true, '先决条件：check 后可装')
    const started = await reader1.install({ checkId: checked.receipt.checkId, requestId: 'req-inflight', from: 'panel' })
    assert.equal(started.job.state, 'installing', '先决条件：安装已起、任务在飞')

    // exec 换包：磁盘清单到 2.0.0（进程仍跑 1.0.0）；此刻再取 reader 会命中新缓存键。
    refs.installedVersion = RELEASE_VERSION
    const reader2 = await getSharedReader('fixture-a', config, readerOverrides(scope, store, refs, gate, RELEASE_VERSION))
    assert.equal(reader2, reader1, '在飞期间必须复用旧实例（换代会把 activeJobId 弄丢）')
    const during = await reader2.status()
    assert.equal(during.job.state, 'installing', '同进程在飞任务不得被合成 interrupted')
    assert.notEqual(during.job.message, 'recovery-required', '不得谎报「上一次进程异常中断」')
    assert.equal(store.peek().state, 'installing', '磁盘上仍是在飞事实（不是 interrupted）')

    gate.resolve()
    const settled = await waitFor(async () => {
      const snap = await reader1.status()
      return snap.job && snap.job.state !== 'installing' && snap.job.state !== 'verifying' ? snap : null
    }, '任务收尾')

    const reader3 = await getSharedReader('fixture-a', config, readerOverrides(scope, store, refs, gate, RELEASE_VERSION))
    assert.notEqual(reader3, reader1, '任务收尾后应恢复换代（用新的运行版本建实例）')
    const after = await reader3.status()
    assert.notEqual(after.job.state, 'interrupted', '已真实完成的任务不得报中断')
    assert.ok(
      after.job.state === 'completed' || after.job.state === 'restart-required',
      `收尾后终态应是 completed/restart-required，实际 ${after.job.state}`
    )
    // 旧实例的 readRunningVersion 仍是 1.0.0（进程确实还没重启）→ 读成 restart-required；
    // 新实例按 2.0.0 建 → completed。两者都是「已完成」的诚实口径，关键是都不是 interrupted。
    assert.ok(
      settled.job.state === 'restart-required' || settled.job.state === 'completed',
      `旧实例收尾后应是 restart-required/completed，实际 ${settled.job.state}`
    )
  })

  it('反向不回归：真·进程重启后，遗留 installing 任务仍诚实报 interrupted/recovery-required', async () => {
    const scope = await makeScope()
    const store = memoryJobStore()
    const refs = { installedVersion: '2.0.0' }
    const gate = deferred()
    const config = resolveUpdateConfig({ pluginId: 'fixture-a', prefix: 'fxa', targetPackageName: TARGET })
    await store.writeRaw({
      id: 'job-crashed',
      state: 'installing',
      targetVersion: RELEASE_VERSION,
      requestId: 'req-crashed',
      startedAt: 1_000_000,
    })
    // 进程重启：单例复位（与 tests/issue-179-job-persistence.test.mjs 同一模拟口径）。
    resetSharedUpdateReaderState()
    const reader = await getSharedReader('fixture-a', config, readerOverrides(scope, store, refs, gate, '1.0.0'))
    const snap = await reader.status()
    assert.equal(snap.job.state, 'interrupted', '跨进程遗留任务必须换算成中断')
    assert.equal(snap.job.message, 'recovery-required')
    assert.equal(snap.blockedReason, 'recovery-required')
  })
})

process.on('exit', () => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})
