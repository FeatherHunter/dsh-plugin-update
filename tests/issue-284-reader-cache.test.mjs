/**
 * tests/issue-284-reader-cache.test.mjs —— #284 真机暴露的产品 BUG 回归：跨目标轮询不得把「查过什么」丢掉。
 *
 * 现场（真机 run 284-20261103T151900）：同一 web 宿主里 fxa-a / fxb-b 两个面板每 5s 轮询。src/host/capabilities.ts
 * 的单例槽只认「最后一个电话的缓存键」，两个目标的电话交替进来就交替新建读取器实例；A 实例上 check 的
 * 结论（checked）随旧实例被丢下，下一条 status 电话建成的新实例只能报 latestVersion=null → 日志每轮
 * status.changed unknown unknownCause=no-latest，面板在「已是最新」（#284 另一处修复）与「不知道」之间抖。
 *
 * 修法：按**完整缓存键**（插件标识 / 前缀 / 运行版本 / 使用范围 / 家目录 / 环境等，见 getSharedReader）保留
 * 最近用过的读取器，同键直接复用、不论是否在飞；运行版本变化仍是新键，所以换代语义不变（#278/#266 的
 * 在飞保护逻辑保留在缓存命中之后）。
 *
 * 断言口径：
 *  1) 同一键连续取：严格同一实例，且 check 的结论（status().latestVersion）仍在。
 *  2) 两个目标交替轮询：各自取回**各自**的原实例，两边的 check 结论都不丢（修前第二条会红）。
 *  3) 运行版本变化：不得返回旧实例（换代）；换代后的新实例没有旧的 check 结论。
 *  4) #268 busy-identity 不回归：在飞实例即使槽被别的目标挤掉，仍按身份找回，任务不被误判 interrupted。
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
  const root = await mkdtemp(join(tmpdir(), 'dpu-284-reader-'))
  tmpRoots.push(root)
  const home = join(root, 'home')
  const profile = join(root, 'profile')
  const pkgDir = join(root, 'target-pkg')
  await mkdir(profile, { recursive: true })
  await mkdir(pkgDir, { recursive: true })
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: TARGET, version: '1.0.0', main: 'index.js', description: 'fake target for #284 regression' })
  )
  return { root, home, profile, pkgDir }
}

function overridesOf(scope, store, refs, gate, runningVersion = '0.0.1') {
  return {
    env: {},
    osHome: scope.root,
    homeDir: scope.home,
    profileDir: scope.profile,
    profileName: 'web',
    targetPackageDir: scope.pkgDir,
    runningVersion,
    fetchImpl: fakeFetch(),
    now: () => 1_000_000,
    randomId: (() => {
      let n = 0
      return () => `id-284-${(n += 1)}`
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
      installationKey: 'key-284',
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

async function waitFor(fn, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

const configA = resolveUpdateConfig({ pluginId: 'fixture-a', prefix: 'fxa', targetPackageName: TARGET })
const configB = resolveUpdateConfig({ pluginId: 'fixture-b', prefix: 'fxb', targetPackageName: TARGET })

describe('#284：读取器按完整缓存键保留（跨目标轮询不丢 check 结论）', () => {
  beforeEach(() => {
    resetSharedUpdateReaderState()
  })

  it('同一键连续取：同一实例，且 check 结论仍在', async () => {
    const scope = await makeScope()
    const store = memoryJobStore()
    const refs = { installedVersion: '0.0.1' }
    const gate = deferred()

    const reader1 = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate))
    const checked = await reader1.check()
    assert.equal(checked.snapshot.latestVersion, RELEASE_VERSION, '先决条件：check 拿到最新版')

    const reader2 = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate))
    assert.equal(reader2, reader1, '同一完整键必须命中同一实例')
    const snap = await reader2.status()
    assert.equal(snap.latestVersion, RELEASE_VERSION, 'check 结论必须还在（不能因再取一次就丢）')
  })

  it('两个目标交替轮询：各自取回原实例，两边 check 结论都保留（修前此处红）', async () => {
    const scope = await makeScope()
    const store = memoryJobStore()
    const refs = { installedVersion: '0.0.1' }
    const gate = deferred()

    const readerA = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate))
    const checkedA = await readerA.check()
    assert.equal(checkedA.snapshot.latestVersion, RELEASE_VERSION)
    const readerB = await getSharedReader('fixture-b', configB, overridesOf(scope, store, refs, gate))
    assert.notEqual(readerB, readerA, '先决条件：B 是另一个目标（另一个缓存键）')
    const checkedB = await readerB.check()
    assert.equal(checkedB.snapshot.latestVersion, RELEASE_VERSION)

    // 真机形态：A 的下一条轮询电话在 B 之后进来。
    const readerA2 = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate))
    assert.equal(readerA2, readerA, 'A 再次进来必须取回 A 的原实例（不能被 B 挤掉后重建）')
    assert.equal((await readerA2.status()).latestVersion, RELEASE_VERSION, 'A 的 check 结论不得丢')

    const readerB2 = await getSharedReader('fixture-b', configB, overridesOf(scope, store, refs, gate))
    assert.equal(readerB2, readerB, 'B 再次进来必须取回 B 的原实例')
    assert.equal((await readerB2.status()).latestVersion, RELEASE_VERSION, 'B 的 check 结论不得丢')
  })

  it('运行版本变化：不得返回旧实例（换代），新实例没有旧 check 结论', async () => {
    const scope = await makeScope()
    const store = memoryJobStore()
    const refs = { installedVersion: '0.0.1' }
    const gate = deferred()

    const oldReader = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate, '0.0.1'))
    await oldReader.check()
    assert.equal((await oldReader.status()).latestVersion, RELEASE_VERSION, '先决条件：旧实例有 check 结论')

    const newReader = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate, RELEASE_VERSION))
    assert.notEqual(newReader, oldReader, '运行版本变化必须换代（不能拿旧实例冒充）')
    assert.equal((await newReader.status()).latestVersion, null, '新实例还没查过，必须诚实报「不知道」而不是继承旧结论')

    // 回到旧键：缓存按完整键保留，旧实例与它的 checked 都还在（这也正是跨轮询记忆的用途）。
    const oldAgain = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate, '0.0.1'))
    assert.equal(oldAgain, oldReader, '同完整键命中缓存实例')
    assert.equal((await oldAgain.status()).latestVersion, RELEASE_VERSION)
  })

  it('#268 busy-identity 不回归：在飞实例被别的目标挤掉后仍按身份找回，任务不被误判 interrupted', async () => {
    const scope = await makeScope()
    const store = memoryJobStore()
    const refs = { installedVersion: '0.0.1' }
    const gate = deferred()

    const readerA = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate, '0.0.1'))
    const checked = await readerA.check()
    assert.equal(checked.snapshot.canInstall, true, '先决条件：可装')
    const started = await readerA.install({ checkId: checked.receipt.checkId, requestId: 'req-inflight-a', from: 'panel' })
    assert.equal(started.job.state, 'installing', '先决条件：安装在飞')

    // 另一个目标的电话进来（真机：批量驱动 / B 面板轮询）。
    const readerB = await getSharedReader('fixture-b', configB, overridesOf(scope, store, refs, gate, '0.0.1'))
    assert.notEqual(readerB, readerA, '先决条件：B 的电话确实进了槽')

    // exec 换包：磁盘清单到 2.0.0（进程仍跑 0.0.1）；A 的收尾电话按新运行版本进来。
    refs.installedVersion = RELEASE_VERSION
    const readerA2 = await getSharedReader('fixture-a', configA, overridesOf(scope, store, refs, gate, RELEASE_VERSION))
    assert.equal(readerA2, readerA, '在飞期间必须按身份找回旧实例（#268 语义不得被缓存改动破坏）')
    const during = await readerA2.status()
    assert.equal(during.job.state, 'installing', '同进程在飞任务不得被合成 interrupted')
    assert.notEqual(during.job.message, 'recovery-required', '不得误报「上一次进程异常中断」')
    assert.equal(store.peek().state, 'installing', '磁盘上仍是在飞事实')

    gate.resolve()
    const settled = await waitFor(async () => {
      const snap = await readerA.status()
      return snap.job && snap.job.state !== 'installing' && snap.job.state !== 'verifying' ? snap : null
    }, '任务收尾')
    assert.ok(
      settled.job.state === 'completed' || settled.job.state === 'restart-required',
      `旧实例收尾后应是 completed/restart-required，实际 ${settled.job.state}`
    )
  })
})

process.on('exit', () => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})
