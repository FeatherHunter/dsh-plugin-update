/**
 * tests/target-resolution.test.mjs —— issue #3：自锚定在普通依赖形态下永久失效。
 *
 * 只测外部行为：在电话层与读取器层断言普通依赖形态可用、老 vendor 形态不回归、
 * 显式目录覆盖生效、定位不到时诚实失败。不测内部私有函数名与常量。
 * 真实临时目录搭假使用范围（前缀隔离），不碰生产路径；网络一律用假件。
 *
 * 背景：包曾用“本包自己住在哪”（import.meta.url 向上找目标包名）回答“要更新的包在哪”，
 * 以依赖形态住在 <范围>/node_modules/dsh-plugin-update/ 时向上永远不拐进 sibling 的
 * <范围>/node_modules/<目标包>，loaded 恒 null → 假 installation-changed。本文件锁住修法：
 * 按包名解析（require.resolve + 手工 sibling 步行绕过 exports 映射 + 自锚定兜底），
 * 显式 targetPackageDir 优先，定位不到诚实失败不再猜 profiles/web。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 'demo-plugin'
const VERSION = '0.3.19'
const NEWER = '0.4.0'
const REGISTRY = 'https://registry.npmjs.org/'

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

/** 契约完整的假目标包：main、exports["./client"]、dsh.bundle.patch 三件套齐（刻意不导出 "." 与 "./package.json"，与 issue 现场一致）。 */
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

function makeProfile() {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-target-'))
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: `^${VERSION}` },
  })
  makeTargetPackage(join(profileDir, 'node_modules', TARGET), VERSION)
  return profileDir
}

/** 把本包 build 产物以“普通依赖形态”塞进假范围：<范围>/node_modules/dsh-plugin-update/dist。 */
function vendorAsDependency(profileDir) {
  const dest = join(profileDir, 'node_modules', 'dsh-plugin-update', 'dist')
  mkdirSync(dest, { recursive: true })
  cpSync(join(PKG_DIR, 'dist'), dest, { recursive: true })
  writeJson(join(profileDir, 'node_modules', 'dsh-plugin-update', 'package.json'), {
    name: 'dsh-plugin-update',
    version: '0.1.2',
    type: 'module',
  })
  return dest
}

async function importFresh(distDir, name) {
  const url = pathToFileURL(join(distDir, name)).href + '?x=' + Date.now() + Math.random()
  return import(url)
}

function fakeFetchNewer(targetName = TARGET, version = NEWER) {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(targetName)}/latest`)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: targetName,
          version,
          engines: { node: '>=22' },
          dist: {
            tarball: `${REGISTRY}${targetName}/-/${targetName}-${version}.tgz`,
            integrity: 'sha512-' + 'A'.repeat(86) + '==',
          },
        }),
    }
  }
}

const tmpRoots = []

before(() => {})
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #3：普通依赖形态按包名解析（验收 1）', () => {
  it('resolveTargetPackage 从依赖位置找到 sibling，不受 exports 映射限制', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const distDir = vendorAsDependency(profileDir)
    const reader = await importFresh(distDir, 'reader.js')
    const found = await reader.resolveTargetPackage(TARGET)
    assert.ok(found, '普通依赖形态必须定位到目标包')
    assert.equal(found.directory, await realpath(join(profileDir, 'node_modules', TARGET)))
    assert.equal(found.manifest.version, VERSION)
  })

  it('电话层零覆盖：不传 runningVersion / profileDir 也能认出版本与范围（验收 3 第一条路径）', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const distDir = vendorAsDependency(profileDir)
    const host = await importFresh(distDir, 'host.js')
    host.__resetSharedUpdateReaderForTests()
    const update = host.createHostUpdate(
      {
        readerOverrides: {
          profileName: 'web',
          homeDir: profileDir,
          environmentKind: 'cli',
          targetPackageName: TARGET,
          fetchImpl: async () => {
            throw new Error('no-net')
          },
          now: () => 1_000_000,
          randomId: () => 'id-1',
          nodeVersion: '22.0.0',
        },
      },
      { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: TARGET }
    )
    const out = await update.handlers['repro.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.blockedReason, null)
    assert.equal(out.snapshot.runningVersion, VERSION)
    assert.equal(out.snapshot.installedVersion, VERSION)
  })

  it('有新版时 canInstall 为真：普通依赖形态一键升级可用（验收 1）', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const distDir = vendorAsDependency(profileDir)
    const host = await importFresh(distDir, 'host.js')
    host.__resetSharedUpdateReaderForTests()
    const update = host.createHostUpdate(
      {
        readerOverrides: {
          runningVersion: VERSION,
          profileDir,
          profileName: 'web',
          homeDir: profileDir,
          environmentKind: 'cli',
          targetPackageName: TARGET,
          fetchImpl: fakeFetchNewer(),
          now: () => 1_000_000,
          randomId: (() => {
            let n = 0
            return () => `id-${(n += 1)}`
          })(),
          nodeVersion: '22.0.0',
        },
      },
      { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: TARGET }
    )
    const status = await update.handlers['repro.updateStatus']({})
    assert.equal(status.ok, true)
    assert.equal(status.snapshot.blockedReason, null)
    const checked = await update.handlers['repro.updateCheck']({})
    assert.equal(checked.ok, true)
    assert.equal(checked.snapshot.latestVersion, NEWER)
    assert.equal(checked.snapshot.canInstall, true)
    assert.ok(checked.receipt && typeof checked.receipt.checkId === 'string')
  })
})

describe('issue #3：推断两条路径在两种形态下都正确（验收 3）', () => {
  it('只传 runningVersion：profileDir 从已装位置反推，不读错范围', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const distDir = vendorAsDependency(profileDir)
    const host = await importFresh(distDir, 'host.js')
    host.__resetSharedUpdateReaderForTests()
    const update = host.createHostUpdate(
      {
        readerOverrides: {
          runningVersion: VERSION,
          profileName: 'web',
          homeDir: profileDir,
          environmentKind: 'cli',
          targetPackageName: TARGET,
          fetchImpl: async () => {
            throw new Error('no-net')
          },
          now: () => 1_000_000,
          randomId: () => 'id-1',
          nodeVersion: '22.0.0',
        },
      },
      { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: TARGET }
    )
    const out = await update.handlers['repro.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.blockedReason, null)
    assert.equal(out.snapshot.installedVersion, VERSION)
  })

  it('只传 profileDir：runningVersion 从目标包清单反推', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const distDir = vendorAsDependency(profileDir)
    const host = await importFresh(distDir, 'host.js')
    host.__resetSharedUpdateReaderForTests()
    const update = host.createHostUpdate(
      {
        readerOverrides: {
          profileDir,
          profileName: 'web',
          homeDir: profileDir,
          environmentKind: 'cli',
          targetPackageName: TARGET,
          fetchImpl: async () => {
            throw new Error('no-net')
          },
          now: () => 1_000_000,
          randomId: () => 'id-1',
          nodeVersion: '22.0.0',
        },
      },
      { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: TARGET }
    )
    const out = await update.handlers['repro.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.blockedReason, null)
    assert.equal(out.snapshot.runningVersion, VERSION)
  })
})

describe('issue #3：老形态不回归（验收 2）', () => {
  it('vendor 在目标包内部时仍定位到目标包自身', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const targetDir = join(profileDir, 'node_modules', TARGET)
    // 老形态：更新包代码住在目标包内部（目标包的子目录）。
    const innerDist = join(targetDir, 'src', 'updatePkg', 'dist')
    mkdirSync(innerDist, { recursive: true })
    cpSync(join(PKG_DIR, 'dist'), innerDist, { recursive: true })
    const reader = await importFresh(innerDist, 'reader.js')
    const found = await reader.resolveTargetPackage(TARGET)
    assert.ok(found, '老形态必须定位到目标包')
    assert.equal(found.directory, await realpath(targetDir))
  })
})

describe('issue #3：显式逃生口（验收 4）', () => {
  it('targetPackageDir 覆盖生效：在包外运行也能指到目标包', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const targetDir = join(profileDir, 'node_modules', TARGET)
    const { resolveTargetPackage } = await import(
      pathToFileURL(join(PKG_DIR, 'dist', 'reader.js')).href + '?x=' + Date.now() + Math.random()
    )
    // 起点故意不在假范围内：只靠自动解析必失败，靠显式目录必须命中。
    const found = await resolveTargetPackage(TARGET, { targetPackageDir: targetDir })
    assert.ok(found)
    assert.equal(found.directory, await realpath(targetDir))
    assert.equal(found.manifest.version, VERSION)
  })

  it('给了显式目录就不走自动解析：指错地方即 null，不回退猜别处', async () => {
    const { resolveTargetPackage } = await import(
      pathToFileURL(join(PKG_DIR, 'dist', 'reader.js')).href + '?x=' + Date.now() + Math.random()
    )
    const missing = await resolveTargetPackage(TARGET, { targetPackageDir: join(tmpdir(), 'dpu-no-such-dir-xyz') })
    assert.equal(missing, null)
  })

  it('读取器接受 targetPackageDir：在包外运行配上它即恢复可用', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const targetDir = join(profileDir, 'node_modules', TARGET)
    const { createUpdateReader } = await import(
      pathToFileURL(join(PKG_DIR, 'dist', 'reader.js')).href + '?x=' + Date.now() + Math.random()
    )
    const reader = createUpdateReader({
      runningVersion: VERSION,
      profileDir,
      pluginId: 'repro-plugin',
      profileName: 'web',
      homeDir: profileDir,
      targetPackageDir: targetDir,
      targetPackageName: TARGET,
      fetchImpl: async () => {
        throw new Error('no-net')
      },
      now: () => 1_000_000,
      randomId: () => 'id-1',
      nodeVersion: '22.0.0',
      environmentKind: 'cli',
    })
    const env = await reader.readEnv()
    assert.equal(env.blockedReason, null)
    assert.equal(env.installedVersion, VERSION)
  })

  it('宿主端到端只给 targetPackageDir：版本与范围全靠显式目录推断（hoisted/开发态主路径）', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    const targetDir = join(profileDir, 'node_modules', TARGET)
    // 主包位置（包外运行）：自动解析必失败，只能靠显式目录。
    const host = await import(pathToFileURL(join(PKG_DIR, 'dist', 'host.js')).href + '?x=' + Date.now() + Math.random())
    host.__resetSharedUpdateReaderForTests()
    const update = host.createHostUpdate(
      {
        readerOverrides: {
          targetPackageDir: targetDir,
          profileName: 'web',
          homeDir: profileDir,
          environmentKind: 'cli',
          targetPackageName: TARGET,
          fetchImpl: async () => {
            throw new Error('no-net')
          },
          now: () => 1_000_000,
          randomId: () => 'id-1',
          nodeVersion: '22.0.0',
        },
      },
      { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: TARGET }
    )
    const out = await update.handlers['repro.updateStatus']({})
    assert.equal(out.ok, true)
    assert.equal(out.snapshot.blockedReason, null)
    assert.equal(out.snapshot.runningVersion, VERSION)
    assert.equal(out.snapshot.installedVersion, VERSION)
  })
})

describe('issue #3：定位不到时诚实失败（验收 5）', () => {
  it('目标包两条路都找不到且没给 profileDir / targetPackageDir：unknown-profile，不猜 web、不产假 installation-changed', async () => {
    const host = await import(pathToFileURL(join(PKG_DIR, 'dist', 'host.js')).href + '?x=' + Date.now() + Math.random())
    host.__resetSharedUpdateReaderForTests()
    const update = host.createHostUpdate(
      {
        readerOverrides: {
          runningVersion: '1.0.0',
          profileName: 'web',
          homeDir: mkdtempSync(join(tmpdir(), 'dpu-unknown-home-')),
          environmentKind: 'cli',
          targetPackageName: 'nonexistent-pkg-xyz-123',
          fetchImpl: async () => {
            throw new Error('no-net')
          },
          now: () => 1_000_000,
          randomId: () => 'id-1',
          nodeVersion: '22.0.0',
        },
      },
      { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: 'nonexistent-pkg-xyz-123' }
    )
    const out = await update.handlers['repro.updateStatus']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'unknown-profile')
  })

  it('无任何覆盖且目标包不存在：同样 unknown-profile（旧逻辑会猜 profiles/web 读错范围）', async () => {
    const host = await import(pathToFileURL(join(PKG_DIR, 'dist', 'host.js')).href + '?x=' + Date.now() + Math.random())
    host.__resetSharedUpdateReaderForTests()
    const home = mkdtempSync(join(tmpdir(), 'dpu-unknown-home2-'))
    tmpRoots.push(home)
    const update = host.createHostUpdate(
      {
        readerOverrides: {
          profileName: 'web',
          homeDir: home,
          environmentKind: 'cli',
          targetPackageName: 'nonexistent-pkg-xyz-123',
          fetchImpl: async () => {
            throw new Error('no-net')
          },
          now: () => 1_000_000,
          randomId: () => 'id-1',
          nodeVersion: '22.0.0',
        },
      },
      { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: 'nonexistent-pkg-xyz-123' }
    )
    const out = await update.handlers['repro.updateStatus']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'unknown-profile')
  })

  it('裸读取器定位不到目标包：unknown-profile，不再是假 installation-changed', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    // 主包位置（包外运行）：自动解析必失败，且刻意不给 targetPackageDir。
    const { createUpdateReader } = await import(
      pathToFileURL(join(PKG_DIR, 'dist', 'reader.js')).href + '?x=' + Date.now() + Math.random()
    )
    const reader = createUpdateReader({
      runningVersion: VERSION,
      profileDir,
      pluginId: 'repro-plugin',
      profileName: 'web',
      homeDir: profileDir,
      targetPackageName: TARGET,
      fetchImpl: async () => {
        throw new Error('no-net')
      },
      now: () => 1_000_000,
      randomId: () => 'id-1',
      nodeVersion: '22.0.0',
      environmentKind: 'cli',
    })
    const env = await reader.readEnv()
    assert.equal(env.installedVersion, VERSION)
    assert.equal(env.blockedReason, 'unknown-profile')
  })
})
