/**
 * tests/issue-183-prerelease-latest.test.mjs —— 缺省 stable 通道 + 远端 latest 是预发布。
 *
 * 契约（#183）：远端 latest 不被本通道接受时，取数口默认仍按 `invalid-release(stage=channel)` 抛；
 * 但检查路径在「已装版本本身就不在本通道」时必须容忍，把真正的结论（channel-mismatch）带出来：
 * 快照报通道不符、`canInstall=false`、latest 如实回填，不再整次 check-failed。
 * 「已装版本在通道内、只是远端 latest 是预发布」这一支仍按旧样大声失败——不取全量包文档就
 * 分不清「只有预发布更新」与「取数真坏了」，宁可大声失败，也不把它悄悄画成「已是最新」。
 *
 * 只测外部行为（电话层），真实临时目录搭假使用范围，网络一律用假件。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-plugin'
const BETA_INSTALLED = '1.8.0-beta.1'
const BETA_NEWER = '1.8.0-beta.3'
const STABLE_OLDER = '1.7.0'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

/** 契约完整的假目标包（main、exports["./client"]、dsh.bundle.patch 三件套齐）。 */
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

function makeProfile(installedVersion) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-183-'))
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: installedVersion },
  })
  makeTargetPackage(join(profileDir, 'node_modules', TARGET), installedVersion)
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

function makeHost(profileDir, { fetchImpl, releaseChannel } = {}) {
  return createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
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
        runInstall: async () => {},
        ...memoryStore(),
      },
    },
    releaseChannel === undefined
      ? { pluginId: 'issue-183-plugin', prefix: 'issue183', targetPackageName: TARGET }
      : { pluginId: 'issue-183-plugin', prefix: 'issue183', targetPackageName: TARGET, releaseChannel }
  )
}

const tmpRoots = []
beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #183：缺省 stable + 远端 latest 是预发布', () => {
  it('已装 beta、latest 也是 beta：检查不再整次失败，报通道不符且不误报可装', async () => {
    const profileDir = makeProfile(BETA_INSTALLED)
    tmpRoots.push(profileDir)
    const host = makeHost(profileDir, { fetchImpl: fakeLatest(BETA_NEWER) })
    const out = await host.handlers['issue183.updateCheck']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.latestVersion, BETA_NEWER, '通道外的 latest 也必须如实回填')
    assert.equal(out.snapshot.blockedReason, 'channel-mismatch')
    assert.equal(out.snapshot.canInstall, false)
  })

  it('已装正式版、latest 是预发布：仍大声失败（不悄悄画成已是最新）', async () => {
    const profileDir = makeProfile(STABLE_OLDER)
    tmpRoots.push(profileDir)
    const host = makeHost(profileDir, { fetchImpl: fakeLatest(BETA_NEWER) })
    const out = await host.handlers['issue183.updateCheck']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'invalid-release')
  })

  it('显式 prerelease 通道：同一份文档照常通过，可安装（旧能力不变）', async () => {
    const profileDir = makeProfile(BETA_INSTALLED)
    tmpRoots.push(profileDir)
    const host = makeHost(profileDir, { fetchImpl: fakeLatest(BETA_NEWER), releaseChannel: 'prerelease' })
    const out = await host.handlers['issue183.updateCheck']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.latestVersion, BETA_NEWER)
    assert.equal(out.snapshot.blockedReason, null)
    assert.equal(out.snapshot.canInstall, true)
  })
})
