/**
 * tests/issue-204-profile-identity.test.mjs —— 宿主内插件必须解析出当前 profile（#204）。
 *
 * 契约：
 * - 在 profile 启动的 DSH 里，插件必须从权威来源拿使用范围身份，不再只靠目标包目录反推：
 *   显式 profileDir/profileName → ctx.profileContext {name,dir} → ctx.desktopProfiles.current
 *   → 显式 readerOverrides.env.DSH_PROFILE_DIR/DSH_PROFILE → 反推兜底 → 都没有才诚实失败。
 * - 解析出的名字要一路带到读取器：手工命令 `--profile <名>`、环境种类判定都用它。
 * - 没有任何来源时的 old 行为不变：目标包定位不到 → unknown-profile；
 *   目标包定位到但反推不到（junction/外部目录，issue #153）→ dev-source。
 *
 * 只测外部行为（电话层），真实临时目录搭假 profile，网络一律用假件。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-plugin'
const INSTALLED = '1.0.0'
const NEWER = '1.1.0'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='
const LATEST_URL = `${REGISTRY}${encodeURIComponent(TARGET)}/latest`

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

/** 真实临时 profile：目标包装在 `<profile>/node_modules/<TARGET>`（installedVersion=null 时未安装）。 */
function makeProfile(installedVersion) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-204-'))
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: installedVersion ? { [TARGET]: installedVersion } : {},
  })
  if (installedVersion) makeTargetPackage(join(profileDir, 'node_modules', TARGET), installedVersion)
  return profileDir
}

/** 目标包副本住在 profile 外（模拟 junction / 外部目录 / 多副本：反推必失败）。 */
function makeExternalCopy(version) {
  const root = mkdtempSync(join(tmpdir(), 'dpu-204-ext-'))
  makeTargetPackage(join(root, TARGET), version)
  return join(root, TARGET)
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

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(JSON.stringify(body).length) },
    text: async () => JSON.stringify(body),
  }
}

function releaseDoc(version) {
  return {
    name: TARGET,
    version,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`, integrity: INTEGRITY },
  }
}

/** 假 registry：只服务 `/latest`，其余地址一律断言失败。 */
function fakeLatest(version, seen = []) {
  return async (url) => {
    seen.push(url)
    if (url !== LATEST_URL) assert.fail(`意外的取数地址：${url}`)
    return jsonResponse(releaseDoc(version))
  }
}

/** 假 Cordis ctx：按键返回指定服务。 */
function fakeCtx(services) {
  return {
    get(name) {
      return services[name]
    },
  }
}

function makeHost({ ctx, env, profileDir, profileName, targetPackageDir, fetchImpl, fires = [] } = {}) {
  return createHostUpdate(
    {
      ...(ctx === undefined ? {} : { ctx }),
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
      readerOverrides: {
        ...(env === undefined ? {} : { env }),
        ...(profileDir === undefined ? {} : { profileDir }),
        ...(profileName === undefined ? {} : { profileName }),
        ...(targetPackageDir === undefined ? {} : { targetPackageDir }),
        homeDir: profileDir ?? undefined,
        fetchImpl,
        now: () => 1_000_000,
        randomId: () => 'id-1',
        nodeVersion: '22.0.0',
        targetPackageName: TARGET,
        runInstall: async () => {},
        ...memoryStore(),
      },
    },
    { pluginId: 'issue-204-plugin', prefix: 'issue204', targetPackageName: TARGET }
  )
}

const tmpRoots = []
beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #204：宿主内必须解析出当前 profile', () => {
  it('ctx.profileContext 是权威来源：目标包在 profile 外也能查出更新，命令用真实 profile 名', async () => {
    const profileDir = makeProfile(INSTALLED)
    const externalTarget = makeExternalCopy(INSTALLED)
    tmpRoots.push(profileDir, externalTarget)
    const seen = []
    const host = makeHost({
      ctx: fakeCtx({ profileContext: { name: 'web', dir: profileDir } }),
      targetPackageDir: externalTarget,
      fetchImpl: fakeLatest(NEWER, seen),
    })
    const out = await host.handlers['issue204.updateCheck']({})
    assert.equal(out.ok, true, '有权威 profile 身份时不许再报认不出使用范围')
    assert.equal(out.snapshot.installed, true)
    assert.equal(out.snapshot.runningVersion, INSTALLED)
    assert.equal(out.snapshot.latestVersion, NEWER)
    assert.match(String(out.manual), /--profile web\b/, '手工命令必须带上真实 profile 名')
    assert.deepEqual(seen, [LATEST_URL])
  })

  it('desktopProfiles.current 也是权威来源：第三方 Desktop 的 current 身份可用', async () => {
    const profileDir = makeProfile(INSTALLED)
    const externalTarget = makeExternalCopy(INSTALLED)
    tmpRoots.push(profileDir, externalTarget)
    const host = makeHost({
      ctx: fakeCtx({ desktopProfiles: { current: { name: 'desk', dir: profileDir } } }),
      targetPackageDir: externalTarget,
      fetchImpl: fakeLatest(NEWER),
    })
    const out = await host.handlers['issue204.updateCheck']({})
    assert.equal(out.ok, true)
    assert.match(String(out.manual), /--profile desk\b/)
  })

  it('显式 env 快照 DSH_PROFILE_DIR/DSH_PROFILE 可作为集成方注入来源', async () => {
    const profileDir = makeProfile(INSTALLED)
    const externalTarget = makeExternalCopy(INSTALLED)
    tmpRoots.push(profileDir, externalTarget)
    const host = makeHost({
      env: { DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'envprof' },
      targetPackageDir: externalTarget,
      fetchImpl: fakeLatest(NEWER),
    })
    const out = await host.handlers['issue204.updateCheck']({})
    assert.equal(out.ok, true)
    assert.match(String(out.manual), /--profile envprof\b/)
  })

  it('任何权威来源都没有、目标包也定位不到：仍诚实报 unknown-profile（边界不变）', async () => {
    const host = makeHost({ fetchImpl: fakeLatest(NEWER) })
    const out = await host.handlers['issue204.updateCheck']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'unknown-profile')
  })

  it('任何权威来源都没有、目标包定位到但在外部目录：仍诚实报 dev-source（#153 语义不变）', async () => {
    const externalTarget = makeExternalCopy(INSTALLED)
    tmpRoots.push(externalTarget)
    const host = makeHost({ targetPackageDir: externalTarget, fetchImpl: fakeLatest(NEWER) })
    const out = await host.handlers['issue204.updateCheck']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'dev-source')
  })

  it('profileContext.dir 非法（相对路径）：跳过该来源，不崩，按后续来源/诚实失败', async () => {
    const externalTarget = makeExternalCopy(INSTALLED)
    tmpRoots.push(externalTarget)
    const host = makeHost({
      ctx: fakeCtx({ profileContext: { name: 'web', dir: 'relative/profile' } }),
      targetPackageDir: externalTarget,
      fetchImpl: fakeLatest(NEWER),
    })
    const out = await host.handlers['issue204.updateCheck']({})
    assert.equal(out.ok, false, '非法目录不得当作身份')
    assert.equal(out.error, 'dev-source')
  })
})
