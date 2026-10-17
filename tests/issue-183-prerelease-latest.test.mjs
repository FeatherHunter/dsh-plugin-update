/**
 * tests/issue-183-prerelease-latest.test.mjs —— 缺省 stable 通道 + 远端 latest 是预发布。
 *
 * 契约（#183，0.18.9 主路径 + 2026-10-18 剩余子项）：
 * - 远端 latest 不被本通道接受时，取数口默认仍按 `invalid-release(stage=channel)` 抛；
 * - 检查路径在「已装版本本身就不在本通道」时必须容忍，把真正的结论（channel-mismatch）带出来：
 *   快照报通道不符、`canInstall=false`、latest 如实回填，不再整次 check-failed；
 * - 「已装版本在通道内、只有远端 latest 是预发布」这一支走**真修复**：取全量包文档，
 *   在本通道允许的版本里找最高发行版——有更新的正式版就正常给更新，没有就诚实呈现
 *   「本通道暂无更新」；全量包文档取不到就大声 check-failed，绝不悄悄画成「已是最新」。
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
const STABLE_NEWER = '1.7.5'
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

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => String(JSON.stringify(body).length) },
    text: async () => JSON.stringify(body),
  }
}

/** latest 文档（与旧回归同一个假件形状）。 */
function releaseDoc(version) {
  return {
    name: TARGET,
    version,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`, integrity: INTEGRITY },
  }
}

/** 全量包文档的 versions 条目（不需要 name/version 字段：键就是版本号）。 */
function releaseEntry(version) {
  return {
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`, integrity: INTEGRITY },
  }
}

const LATEST_URL = `${REGISTRY}${encodeURIComponent(TARGET)}/latest`
const PACKUMENT_URL = `${REGISTRY}${encodeURIComponent(TARGET)}`

/**
 * 假 registry：`/latest` 返回 latest 文档；不带路径后缀的包地址返回全量包文档。
 * `packumentStatus` 非 200 时模拟取全量包文档失败。
 */
function fakeRegistry({ latest = BETA_NEWER, versions = {}, packumentStatus = 200, seen = [] } = {}) {
  return async (url) => {
    seen.push(url)
    if (url === LATEST_URL) return jsonResponse(releaseDoc(latest))
    if (url === PACKUMENT_URL) {
      if (packumentStatus !== 200) return jsonResponse({}, { ok: false, status: packumentStatus })
      return jsonResponse({ name: TARGET, 'dist-tags': { latest }, versions })
    }
    assert.fail(`意外的取数地址：${url}`)
  }
}

function makeHost(profileDir, { fetchImpl, releaseChannel, fires = [] } = {}) {
  return createHostUpdate(
    {
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
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
    const seen = []
    const host = makeHost(profileDir, {
      fetchImpl: fakeRegistry({ latest: BETA_NEWER, seen, versions: { [BETA_INSTALLED]: releaseEntry(BETA_INSTALLED), [BETA_NEWER]: releaseEntry(BETA_NEWER) } }),
    })
    const out = await host.handlers['issue183.updateCheck']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.latestVersion, BETA_NEWER, '通道外的 latest 也必须如实回填')
    assert.equal(out.snapshot.blockedReason, 'channel-mismatch')
    assert.equal(out.snapshot.canInstall, false)
    assert.deepEqual(seen, [LATEST_URL], '已装版本不在通道内：容忍分支够用，不额外取全量包文档')
  })

  it('已装正式版、latest 是预发布且本通道无更新：不再失败，诚实呈现本通道已是最新', async () => {
    const profileDir = makeProfile(STABLE_OLDER)
    tmpRoots.push(profileDir)
    const seen = []
    const fires = []
    const host = makeHost(profileDir, {
      fetchImpl: fakeRegistry({
        seen,
        versions: { [STABLE_OLDER]: releaseEntry(STABLE_OLDER), [BETA_NEWER]: releaseEntry(BETA_NEWER) },
      }),
      fires,
    })
    const out = await host.handlers['issue183.updateCheck']({})
    assert.equal(out.ok, true, '不许再整次 check-failed')
    assert.equal(out.snapshot.latestVersion, STABLE_OLDER, 'latestVersion 报本通道最新发行版，不是预发布 latest')
    assert.equal(out.snapshot.blockedReason, null)
    assert.equal(out.snapshot.canInstall, false, '本通道没有更新，不能宣称可装')
    assert.deepEqual(seen, [LATEST_URL, PACKUMENT_URL], '先问 latest，通道外才回退全量包文档')
    assert.equal(fires.some((f) => f.event === 'update.check.fail'), false, '不落检查失败')
    const done = fires.find((f) => f.event === 'update.check.done')
    assert.ok(done, '检查成功行照常落')
    assert.equal(done.fields.latest, STABLE_OLDER)
    assert.equal(done.fields.current, STABLE_OLDER)
  })

  it('已装正式版、latest 是预发布但有更新的正式版：真修复出可用更新', async () => {
    const profileDir = makeProfile(STABLE_OLDER)
    tmpRoots.push(profileDir)
    const seen = []
    const fires = []
    const host = makeHost(profileDir, {
      fetchImpl: fakeRegistry({
        seen,
        versions: {
          [STABLE_OLDER]: releaseEntry(STABLE_OLDER),
          [STABLE_NEWER]: releaseEntry(STABLE_NEWER),
          [BETA_NEWER]: releaseEntry(BETA_NEWER),
        },
      }),
      fires,
    })
    const out = await host.handlers['issue183.updateCheck']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.latestVersion, STABLE_NEWER)
    assert.equal(out.snapshot.blockedReason, null)
    assert.equal(out.snapshot.canInstall, true, '本通道有更新的发行版：应可安装')
    assert.equal(out.snapshot.identity, 'update')
    assert.deepEqual(seen, [LATEST_URL, PACKUMENT_URL])
    const done = fires.find((f) => f.event === 'update.check.done')
    assert.equal(done.fields.latest, STABLE_NEWER)
  })

  it('通道回退的检查结论可以安装：装前复核与检查同口径，不误报 check-expired', async () => {
    const profileDir = makeProfile(STABLE_OLDER)
    tmpRoots.push(profileDir)
    const seen = []
    const host = makeHost(profileDir, {
      fetchImpl: fakeRegistry({
        seen,
        versions: { [STABLE_OLDER]: releaseEntry(STABLE_OLDER), [STABLE_NEWER]: releaseEntry(STABLE_NEWER) },
      }),
    })
    const check = await host.handlers['issue183.updateCheck']({})
    assert.equal(check.ok, true)
    assert.equal(check.snapshot.canInstall, true)
    const out = await host.handlers['issue183.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-183' })
    assert.equal(out.ok, true, `装前复核必须认可通道回退得到的版本：${JSON.stringify(out).slice(0, 240)}`)
  })

  it('全量包文档取不到：大声 check-failed，不悄悄画成已是最新', async () => {
    const profileDir = makeProfile(STABLE_OLDER)
    tmpRoots.push(profileDir)
    const fires = []
    const host = makeHost(profileDir, {
      fetchImpl: fakeRegistry({ packumentStatus: 503, versions: {} }),
      fires,
    })
    const out = await host.handlers['issue183.updateCheck']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'check-failed')
    const fail = fires.find((f) => f.event === 'update.check.fail')
    assert.ok(fail, '检查失败行必须落')
    assert.equal(fail.fields.httpStatus, 503)
  })

  it('显式 prerelease 通道：同一份文档照常通过，可安装（旧能力不变）', async () => {
    const profileDir = makeProfile(BETA_INSTALLED)
    tmpRoots.push(profileDir)
    const seen = []
    const host = makeHost(profileDir, {
      fetchImpl: fakeRegistry({ latest: BETA_NEWER, seen }),
      releaseChannel: 'prerelease',
    })
    const out = await host.handlers['issue183.updateCheck']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.latestVersion, BETA_NEWER)
    assert.equal(out.snapshot.blockedReason, null)
    assert.equal(out.snapshot.canInstall, true)
    assert.deepEqual(seen, [LATEST_URL], 'prerelease 通道直接收：不需要回退')
  })
})
