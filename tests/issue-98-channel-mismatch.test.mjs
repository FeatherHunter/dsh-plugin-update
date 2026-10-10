/**
 * tests/issue-98-channel-mismatch.test.mjs —— 已装预发布版在缺省 stable 通道下坍缩成 unknown-profile。
 *
 * 只测外部行为：电话层（构造分叉、快照码、使用范围一栏）、读取器层（第二道门）、
 * 手工命令（不给降级）、文案层（blocked/diag 回退）。真实临时目录搭假使用范围，
 * 不碰生产路径；网络一律用假件。
 *
 * 契约（票上 brief v1）：定位得到但版本不被通道接受 → channel-mismatch；
 * 构造期抛错只留给真定位不到与版本非法；缺省 stable 不变。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests, buildDiag } from '../dist/host.js'
import { manualCommand } from '../dist/commands.js'
import { blockedCopy, failureCopy, isKnownFailureCode } from '../dist/panel.js'

const TARGET = 'demo-plugin'
const BETA = '1.8.0-beta.1'
const BETA_NEWER = '1.8.0-beta.3'
const STABLE_NEWER = '1.8.0'
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

function makeBetaProfile(depSpec = BETA) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-98-'))
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    // 缺省精确写法（与 issue 现场 `dsh-mattpocock-skills-deck: 1.8.0-beta.1` 同形）；
    // caret 变体见 registrySpec 用例（`^0.2.0-rc.2` 在真实桌面范围里出现过）。
    dependencies: { [TARGET]: depSpec },
  })
  makeTargetPackage(join(profileDir, 'node_modules', TARGET), BETA)
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

function noNet() {
  return async () => {
    throw new Error('no-net')
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

/** 缺省 stable、无任何 runningVersion 覆盖：复现 issue 现场的接线（全落缺省）。 */
function makeDefaultHost(profileDir, { fetchImpl = noNet(), releaseChannel } = {}) {
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
      ? { pluginId: 'issue-98-plugin', prefix: 'issue98', targetPackageName: TARGET }
      : { pluginId: 'issue-98-plugin', prefix: 'issue98', targetPackageName: TARGET, releaseChannel }
  )
}

const tmpRoots = []
beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #98：缺省 stable + 已装 beta 不再坍缩成 unknown-profile', () => {
  it('最小复现：查状态成功，快照报 channel-mismatch，运行/已装皆为真实 beta 版', async () => {
    const profileDir = makeBetaProfile()
    tmpRoots.push(profileDir)
    const host = makeDefaultHost(profileDir)
    const out = await host.handlers['issue98.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.runningVersion, BETA)
    assert.equal(out.snapshot.installedVersion, BETA)
    assert.equal(out.snapshot.blockedReason, 'channel-mismatch')
    assert.equal(out.snapshot.canInstall, false)
  })

  it('使用范围一栏显示真实范围名，不再是未知', async () => {
    const profileDir = makeBetaProfile()
    tmpRoots.push(profileDir)
    const host = makeDefaultHost(profileDir)
    const out = await host.handlers['issue98.updateStatus']({ includeEnv: true })
    assert.equal(out.ok, true)
    assert.equal(out.env.profileName, 'web')
  })

  it('查新版：远端 stable 更高也如实显示 latest，仍判通道阻拦、不误判无更新', async () => {
    const profileDir = makeBetaProfile()
    tmpRoots.push(profileDir)
    const host = makeDefaultHost(profileDir, { fetchImpl: fakeLatest(STABLE_NEWER) })
    const out = await host.handlers['issue98.updateCheck']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.latestVersion, STABLE_NEWER)
    assert.equal(out.snapshot.blockedReason, 'channel-mismatch')
    assert.equal(out.snapshot.canInstall, false)
  })

  it('显式 prerelease 通道：同盘 beta 全链路正常（安装资格照常判定）', async () => {
    const profileDir = makeBetaProfile()
    tmpRoots.push(profileDir)
    const host = makeDefaultHost(profileDir, { fetchImpl: fakeLatest(BETA_NEWER), releaseChannel: 'prerelease' })
    const status = await host.handlers['issue98.updateStatus']({})
    assert.equal(status.ok, true)
    assert.equal(status.snapshot.blockedReason, null)
    const check = await host.handlers['issue98.updateCheck']({})
    assert.equal(check.ok, true)
    assert.equal(check.snapshot.latestVersion, BETA_NEWER)
    assert.equal(check.snapshot.canInstall, true)
  })

  it('caret 预发布范围依赖同样走通道码，不误判源码安装', async () => {
    const profileDir = makeBetaProfile(`^${BETA}`)
    tmpRoots.push(profileDir)
    const host = makeDefaultHost(profileDir)
    const out = await host.handlers['issue98.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.blockedReason, 'channel-mismatch')
  })

  it('分叉守住：空串运行覆盖与改造前一致，仍报 unknown-profile（不 fallback 磁盘）', async () => {
    const profileDir = makeBetaProfile()
    tmpRoots.push(profileDir)
    const host = createHostUpdate(
      {
        logCtx: { fire: () => {} },
        readerOverrides: {
          runningVersion: '',
          targetPackageDir: join(profileDir, 'node_modules', TARGET),
          profileDir,
          profileName: 'web',
          homeDir: profileDir,
          fetchImpl: noNet(),
          now: () => 1_000_000,
          randomId: () => 'id-1',
          nodeVersion: '22.0.0',
          environmentKind: 'cli',
          targetPackageName: TARGET,
          runInstall: async () => {},
        },
      },
      { pluginId: 'issue-98-plugin', prefix: 'issue98', targetPackageName: TARGET }
    )
    const out = await host.handlers['issue98.updateStatus']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'unknown-profile')
  })

  it('分叉守住：目标包真定位不到仍是 unknown-profile', async () => {
    const profileDir = makeBetaProfile()
    tmpRoots.push(profileDir)
    const host = createHostUpdate(
      {
        logCtx: { fire: () => {} },
        readerOverrides: {
          targetPackageDir: join(profileDir, 'node_modules', 'no-such-pkg'),
          profileDir,
          profileName: 'web',
          homeDir: profileDir,
          fetchImpl: noNet(),
          now: () => 1_000_000,
          randomId: () => 'id-1',
          nodeVersion: '22.0.0',
          environmentKind: 'cli',
          targetPackageName: 'no-such-pkg',
          runInstall: async () => {},
          ...memoryStore(),
        },
      },
      { pluginId: 'issue-98-plugin', prefix: 'issue98', targetPackageName: 'no-such-pkg' }
    )
    const out = await host.handlers['issue98.updateStatus']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'unknown-profile')
  })

  it('分叉守住：清单版本非法仍是 unknown-profile（运行身份无法确立，行为不变）', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dpu-98-badver-'))
    tmpRoots.push(profileDir)
    writeJson(join(profileDir, 'package.json'), {
      name: 'fake-profile',
      version: '0.0.0',
      dependencies: { [TARGET]: '1.0.0' },
    })
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), 'not-a-version')
    const host = makeDefaultHost(profileDir)
    const out = await host.handlers['issue98.updateStatus']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'unknown-profile')
  })
})

describe('issue #98：手工命令不给降级与通道外版本', () => {
  it('beta 运行 + stable 远端更高 → 给升到正式版的命令', () => {
    const command = manualCommand({
      profileName: 'web',
      latestVersion: STABLE_NEWER,
      installedVersion: BETA,
      runningVersion: BETA,
      jobTargetVersion: null,
      blockedReason: 'channel-mismatch',
      sourceInstall: false,
      targetPackageName: TARGET,
      registryUrl: REGISTRY,
    })
    assert.equal(command, `dsh plugin --profile web add --save-exact ${TARGET}@${STABLE_NEWER} --registry=${REGISTRY}`)
  })

  it('beta 运行 + stable 远端更低 → 不给降级命令，回空', () => {
    const command = manualCommand({
      profileName: 'web',
      latestVersion: STABLE_OLDER,
      installedVersion: BETA,
      runningVersion: BETA,
      jobTargetVersion: null,
      blockedReason: 'channel-mismatch',
      sourceInstall: false,
      targetPackageName: TARGET,
      registryUrl: REGISTRY,
    })
    assert.equal(command, null)
  })

  it('真 unknown-profile 仍不给命令（回归守）', () => {
    const command = manualCommand({
      profileName: 'web',
      latestVersion: STABLE_NEWER,
      installedVersion: BETA,
      runningVersion: BETA,
      jobTargetVersion: null,
      blockedReason: 'unknown-profile',
      sourceInstall: false,
      targetPackageName: TARGET,
      registryUrl: REGISTRY,
    })
    assert.equal(command, null)
  })
})

describe('issue #98：文案层（blocked 复用 + diag 回退 + 已知码）', () => {
  it('blockedCopy 有中文标题与行动句，failureCopy 复用阻塞表原文', () => {
    const copy = blockedCopy('channel-mismatch')
    assert.ok(copy && copy.title && copy.action)
    assert.match(copy.title + copy.action, /[\u4e00-\u9fff]/)
    const failure = failureCopy('channel-mismatch')
    assert.ok(failure && failure.zh && failure.act)
    assert.equal(failure.zh, copy.title)
  })

  it('channel-mismatch 判为已知码', () => {
    assert.equal(isKnownFailureCode('channel-mismatch'), true)
  })

  it('diag 回退给通道人话中文，不提使用范围', () => {
    const diag = buildDiag({
      errorCode: 'channel-mismatch',
      phoneKind: 'update-status',
      error: Object.assign(new Error('channel-mismatch'), { code: 'channel-mismatch' }),
      args: {},
    })
    assert.ok(diag && typeof diag.detail === 'string' && diag.detail.trim())
    assert.match(diag.detail, /[\u4e00-\u9fff]/)
    assert.match(diag.detail, /通道/)
    assert.ok(!diag.detail.includes('使用范围'), '通道码不许把用户引向使用范围')
  })
})
