/**
 * tests/issue-134-not-installed.test.mjs —— 「未安装」一等状态（#137 规格，#134 施工）。
 *
 * 只测外部行为（缝 1：宿主公开电话出口 `dist/host.js` 的回包），不直调内部函数：
 * 用真临时 profile 目录造「目标包不在场」（声明依赖但不创建 `node_modules/<pkg>`），
 * 网络一律用假件。prior art：tests/issue-98-channel-mismatch.test.mjs。
 *
 * 钉死的契约（US19 / US24）：
 * 1. 缺席是事实不是错误：`installed === false`、`blockedReason === null`；
 * 2. 两个不同的注入假版号得到同一结论（可安装性不取决于假版号）；
 * 3. 坏包（坏 JSON）仍判 `invalid-installation`，洗不成「未装」；
 * 4. 一次全新安装端到端装上，终态 `restart-required`。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-fresh-plugin'
const REMOTE = '0.3.54'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

/** 声明了依赖、但目标包目录不存在的 profile（「不在场」现场）。 */
function makeAbsentProfile(depSpec = REMOTE) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-134-absent-'))
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: depSpec },
  })
  return profileDir
}

function makeTargetPackage(dir, version) {
  writeJson(join(dir, 'package.json'), {
    name: TARGET,
    version,
    main: './index.js',
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './patch.js' } },
  })
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(join(dir, 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(dir, 'patch.js'), 'module.exports = {}\n')
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

/**
 * 建宿主：显式注入 `runningVersion`（模拟集成方今天传的值——未装时它是假版号，
 * 本包不再采信它作为已装版本）；`materialize` 为真时 runInstall 会把目标包落盘。
 */
function makeHost(profileDir, { runningVersion = '0.0.0', fetchImpl = fakeLatest(REMOTE), materialize = false } = {}) {
  const runInstall =
    materialize === true
      ? async ({ version }) => {
          makeTargetPackage(join(profileDir, 'node_modules', TARGET), version)
        }
      : async () => {}
  return createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion,
        targetPackageDir: join(profileDir, 'node_modules', TARGET),
        profileDir,
        profileName: 'web',
        homeDir: profileDir,
        fetchImpl,
        now: () => 1_000_000,
        randomId: () => 'id-1',
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        runInstall,
        ...memoryStore(),
      },
    },
    { pluginId: 'issue-134-plugin', prefix: 'issue134', targetPackageName: TARGET },
  )
}

const tmpRoots = []
beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #134：不在场是事实（installed=false），不是 invalid-installation', () => {
  it('读状态成功：installed=false、installedVersion=null、blockedReason=null', async () => {
    const profileDir = makeAbsentProfile()
    tmpRoots.push(profileDir)
    const host = makeHost(profileDir)
    const out = await host.handlers['issue134.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.installed, false)
    assert.equal(out.snapshot.installedVersion, null)
    assert.equal(out.snapshot.blockedReason, null)
  })

  it('US19：两个不同的注入假版号得到同一结论（查完可安装）', async () => {
    const dirA = makeAbsentProfile()
    const dirB = makeAbsentProfile()
    tmpRoots.push(dirA, dirB)
    const results = []
    for (const [dir, fake] of [
      [dirA, '0.0.0'],
      [dirB, '9.9.9'],
    ]) {
      const host = makeHost(dir, { runningVersion: fake })
      const check = await host.handlers['issue134.updateCheck']({})
      assert.equal(check.ok, true)
      results.push({
        latestVersion: check.snapshot.latestVersion,
        canInstall: check.snapshot.canInstall,
        blockedReason: check.snapshot.blockedReason,
        installed: check.snapshot.installed,
      })
    }
    assert.deepEqual(results[0], results[1])
    assert.equal(results[0].latestVersion, REMOTE)
    assert.equal(results[0].canInstall, true)
    assert.equal(results[0].blockedReason, null)
  })

  it('查不到远程版本：检查失败是 check-failed，不抛 update-busy、不说安装失败', async () => {
    const profileDir = makeAbsentProfile()
    tmpRoots.push(profileDir)
    const host = makeHost(profileDir, {
      fetchImpl: async () => {
        throw new Error('no-net')
      },
    })
    const out = await host.handlers['issue134.updateCheck']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'check-failed')
  })

  it('坏包洗不成未装：坏 JSON 仍判 invalid-installation 且 installed=true', async () => {
    const profileDir = makeAbsentProfile()
    tmpRoots.push(profileDir)
    const targetDir = join(profileDir, 'node_modules', TARGET)
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'package.json'), '{ broken json')
    const host = makeHost(profileDir)
    const out = await host.handlers['issue134.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.installed, true)
    assert.equal(out.snapshot.blockedReason, 'invalid-installation')
  })

  it('US11 后半：范围清单读不到也按在场走阻拦分支，绝不谎称未安装', async () => {
    const profileDir = makeAbsentProfile()
    tmpRoots.push(profileDir)
    // package.json 写成目录：读清单抛 EISDIR（非 ENOENT）→ 缺席判据不成立，走原判 invalid-installation。
    rmSync(join(profileDir, 'package.json'))
    mkdirSync(join(profileDir, 'package.json'), { recursive: true })
    const host = makeHost(profileDir)
    const out = await host.handlers['issue134.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.blockedReason, 'invalid-installation')
    assert.equal(out.snapshot.installed, true, '在场性无法确认时按在场走，不谎称未安装')
  })

  it('在场回归：在场的包 installed=true（旧行为不塌）', async () => {
    const profileDir = makeAbsentProfile()
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), REMOTE)
    const host = makeHost(profileDir, { runningVersion: REMOTE })
    const out = await host.handlers['issue134.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.installed, true)
    assert.equal(out.snapshot.installedVersion, REMOTE)
  })

  it('端到端：点一次安装把缺席包从无装到有，终态 restart-required', async () => {
    const profileDir = makeAbsentProfile()
    tmpRoots.push(profileDir)
    const host = makeHost(profileDir, { materialize: true })
    const check = await host.handlers['issue134.updateCheck']({})
    assert.equal(check.ok, true)
    assert.equal(check.snapshot.canInstall, true)
    assert.ok(check.receipt && typeof check.receipt.checkId === 'string')
    const installed = await host.handlers['issue134.updateInstall']({
      checkId: check.receipt.checkId,
      requestId: 'req-fresh-1',
    })
    assert.equal(installed.ok, true)
    let last = null
    const deadline = Date.now() + 15000
    for (;;) {
      last = await host.handlers['issue134.updateStatus']({})
      assert.equal(last.ok, true)
      const state = last.snapshot.job ? last.snapshot.job.state : null
      if (state === 'restart-required' || state === 'completed') break
      if (Date.now() > deadline) throw new Error(`安装 15 秒未收尾，最后状态=${state}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(last.snapshot.installed, true)
    assert.equal(last.snapshot.installedVersion, REMOTE)
    assert.equal(last.snapshot.job.state, 'restart-required')
  })
})
