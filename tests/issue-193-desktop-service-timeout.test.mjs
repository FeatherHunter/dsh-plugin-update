/**
 * tests/issue-193-desktop-service-timeout.test.mjs —— 出口一（third-party Desktop 的 desktopPnpm 服务）安装时限（#193，S1，审查 A 线 R3）。
 *
 * 只测外部行为：执行器用假 `desktopPnpm` 零件，宿主用公开电话入口（`dist/host.js`）+ 真临时 profile，
 * 网络一律假件。钉死的契约：
 *
 * 1. 假桌面服务永不收尾、`handle` 没有 `terminate` ⇒ 到 `installTimeoutMs` 必须失败，
 *    人话格如实说「宿主未提供终止能力，这次安装可能仍在后台继续」——不许无限等、不许谎称已终止。
 * 2. 有 `terminate` ⇒ 到点调一次，人话格说「已请求宿主终止」。
 * 3. 到点后 terminate 让它在终止宽限内以 exitCode 0 收尾 ⇒ 按它自己的结局判成功
 *    （不把已经落地的改动记成失败，同出口二 finishCall 的宽限纪律）。
 * 4. `handle.done` 直接 reject（宿主安装服务崩了）⇒ 立即失败、详情写「宿主安装服务异常退出」，
 *    不该伪装成超时。
 * 5. 宿主机级验收：假桌面服务永不收尾 ⇒ 作业必须回到 `failed` 终态（不是永久 installing），
 *    之后不会卡在 update-busy。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createUpdateExecutor, __executorInternals } from '../dist/store.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-desktop-service-plugin'
const INSTALLED = '1.0.0'
const REMOTE = '1.0.1'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='
const GRACE_MS = __executorInternals.TERMINATION_GRACE_MS
const NO_TERMINATE = '安装超时；宿主未提供终止能力，这次安装可能仍在后台继续'
const WITH_TERMINATE = '安装超时，已请求宿主终止'
const CRASHED = '宿主安装服务异常退出'

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

function makeProfile() {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-193-'))
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: `^${INSTALLED}` },
    dsh: { profile: { bundles: [TARGET] } },
  })
  writeJson(join(profileDir, 'node_modules', TARGET, 'package.json'), {
    name: TARGET,
    version: INSTALLED,
    main: './index.js',
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './patch.js' } },
  })
  writeFileSync(join(profileDir, 'node_modules', TARGET, 'index.js'), 'module.exports = {}\n')
  writeFileSync(join(profileDir, 'node_modules', TARGET, 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(profileDir, 'node_modules', TARGET, 'patch.js'), 'module.exports = {}\n')
  return profileDir
}

function memoryStore() {
  let job = null
  return {
    readJob: async () => job,
    writeJob: async (value) => {
      job = value
    },
    tryAcquireLock: async () => true,
    releaseLock: async () => {},
    backupJob: async () => {},
  }
}

function fakeLatest(version) {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(TARGET)}/latest`)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: TARGET,
          version,
          engines: { node: '>=22' },
          dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`, integrity: INTEGRITY },
        }),
    }
  }
}

/** 假桌面服务零件：`runPlugin` 回一个永不落定的 `done`（可加 terminate / reject / 迟到收尾）。 */
function desktopService(handle) {
  return {
    desktopPnpm: { runPlugin: () => handle },
    desktopProfiles: { current: { dir: PROFILE_DIR } },
  }
}

let PROFILE_DIR = ''
const tmpRoots = []

function runWith(parts) {
  return createUpdateExecutor({
    environmentKind: 'desktop',
    profileName: 'desktop',
    profileDir: PROFILE_DIR,
    pluginId: 'issue-193-plugin',
    installTimeoutMs: 40,
    log: () => {},
    ...parts,
  })
}

function never() {
  return new Promise(() => {})
}

/** 给一次调用套上硬上限：到点还没收场就往回交 hang，免得挂死的实现把测试吊住。 */
async function cappedSettle(run, capMs) {
  let timer = null
  const cap = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'hang' }), capMs)
  })
  const attempt = Promise.resolve()
    .then(run)
    .then(
      () => ({ kind: 'ok' }),
      (error) => ({ kind: 'failed', error })
    )
  try {
    return await Promise.race([attempt, cap])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
  PROFILE_DIR = makeProfile()
  tmpRoots.push(PROFILE_DIR)
})

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #193：出口一（desktopPnpm 服务）的安装时限与人话格', () => {
  it('服务永不收尾且没有 terminate ⇒ 到点失败，如实说「宿主未提供终止能力」', async () => {
    const out = await cappedSettle(
      () => runWith(desktopService({ done: never() }))({ version: REMOTE, profileName: 'desktop', environmentKind: 'desktop' }),
      40 + GRACE_MS + 4000
    )
    assert.equal(out.kind, 'failed', `到点必须收场（hang=${out.kind}）`)
    assert.equal(out.error.code, 'install-failed')
    assert.equal(out.error.detail, NO_TERMINATE)
  })

  it('服务永不收尾但有 terminate ⇒ 到点调一次终止，人话格说「已请求宿主终止」', async () => {
    let terminated = 0
    const handle = {
      done: never(),
      terminate: () => {
        terminated += 1
      },
    }
    const out = await cappedSettle(
      () => runWith(desktopService(handle))({ version: REMOTE, profileName: 'desktop', environmentKind: 'desktop' }),
      40 + GRACE_MS + 4000
    )
    assert.equal(out.kind, 'failed')
    assert.equal(out.error.detail, WITH_TERMINATE)
    assert.equal(terminated, 1, '有终止能力就要真调一次，且只一次')
  })

  it('到点后终止宽限内以 exitCode 0 收尾 ⇒ 按它自己的结局判成功（不把已落地的改动记成失败）', async () => {
    let terminated = 0
    const handle = {
      done: never(),
      terminate: () => {
        terminated += 1
        // 宽限期内自己收尾：宿主其实装完了，只是报到晚于 deadline。
        setTimeout(() => handle._resolve({ exitCode: 0 }), 20)
      },
    }
    handle.done = new Promise((resolve) => {
      handle._resolve = resolve
    })
    const out = await cappedSettle(
      () => runWith(desktopService(handle))({ version: REMOTE, profileName: 'desktop', environmentKind: 'desktop' }),
      40 + GRACE_MS + 4000
    )
    assert.equal(out.kind, 'ok', '宽限内成功收尾就不该报失败')
    assert.equal(terminated, 1)
  })

  it('宿主安装服务直接拒绝收尾（done reject）⇒ 立即失败并写「宿主安装服务异常退出」，不伪装成超时', async () => {
    const out = await cappedSettle(
      () => runWith(desktopService({ done: Promise.reject(new Error('service crashed')) }))({ version: REMOTE, profileName: 'desktop', environmentKind: 'desktop' }),
      40 + GRACE_MS + 4000
    )
    assert.equal(out.kind, 'failed')
    assert.equal(out.error.detail, CRASHED)
  })

  it('宿主机级：假桌面服务永不收尾 ⇒ 作业回到 failed 终态（不是永久 installing）', async () => {
    makeHost()
    const host = HOST
    const check = await host.handlers['issue193.updateCheck']({})
    assert.equal(check.ok, true)
    assert.ok(check.receipt && typeof check.receipt.checkId === 'string', '查新版必须带回执')
    const installed = await host.handlers['issue193.updateInstall']({
      checkId: check.receipt.checkId,
      requestId: 'req-193-1',
    })
    assert.equal(installed.ok, true)

    const deadline = Date.now() + 12000
    let snapshot = null
    for (;;) {
      const last = await host.handlers['issue193.updateStatus']({})
      assert.equal(last.ok, true)
      snapshot = last.snapshot
      const state = snapshot.job ? snapshot.job.state : null
      if (state === 'failed' || state === 'restart-required' || state === 'completed') break
      if (Date.now() > deadline) throw new Error(`作业 12 秒未收尾（最后状态=${state}），说明安装时限没生效`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(snapshot.job, '必须有终态任务')
    assert.equal(snapshot.job.state, 'failed')
    assert.equal(snapshot.job.message, `install-failed: ${NO_TERMINATE}`)
  })
})

let HOST = null
function makeHost() {
  HOST = createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion: INSTALLED,
        targetPackageDir: join(PROFILE_DIR, 'node_modules', TARGET),
        profileDir: PROFILE_DIR,
        profileName: 'desktop',
        homeDir: PROFILE_DIR,
        fetchImpl: fakeLatest(REMOTE),
        now: () => 1_000_000,
        randomId: () => 'id-193',
        nodeVersion: '22.0.0',
        environmentKind: 'desktop',
        targetPackageName: TARGET,
        desktopPnpm: { runPlugin: () => ({ done: never() }) },
        desktopProfiles: { current: { dir: PROFILE_DIR } },
        ...memoryStore(),
      },
    },
    { pluginId: 'issue-193-plugin', prefix: 'issue193', targetPackageName: TARGET, installTimeoutMs: 40 }
  )
}
