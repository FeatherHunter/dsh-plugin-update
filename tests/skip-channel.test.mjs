/**
 * tests/skip-channel.test.mjs —— 跳过持久化与版本通道（#16）。
 *
 * 只测外部行为：发行版识别与比较、通道默认 stable、prerelease 显式 opt-in、
 * 精确版锁定、跳过按插件 + 版本隔离与重置。不测内部私有常量与函数名。
 * 落盘走真实临时目录（前缀隔离），不碰生产路径；网络一律用假件。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareReleaseVersions,
  createUpdateCore,
  fetchNpmRelease,
  isPrereleaseVersion,
  isVersionAllowedInChannel,
  validReleaseVersion,
  validVersion,
} from '../dist/service.js'
import { installRecipe, manualCommand } from '../dist/commands.js'
import { resolveUpdateConfig } from '../dist/config.js'
import {
  addSkipped,
  clearSkipped,
  createSkipDiskPorts,
  isVersionSkipped,
  normalizeSkipped,
  skipKey,
} from '../dist/store.js'

const INTEGRITY = 'sha512-' + 'C'.repeat(86) + '=='

function releaseBody(name, version, registry) {
  return JSON.stringify({
    name,
    version,
    engines: { node: '>=22' },
    dist: { tarball: `${registry}${name}/-/${name}-${version}.tgz`, integrity: INTEGRITY },
  })
}

function fakeFetch(expectedUrl, body) {
  return async (url) => {
    assert.equal(url, expectedUrl)
    return { ok: true, headers: { get: () => null }, text: async () => body }
  }
}

function basePorts(overrides = {}) {
  return {
    readRunningVersion: () => '1.0.0',
    readInstalled: async () => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: null,
      profileDir: null,
      installedVersion: '1.0.0',
      packageValid: true,
      sourceInstall: false,
      blockedReason: null,
      installationKey: 'key-1',
      eligible: true,
    }),
    fetchImpl: fakeFetch(
      'https://registry.npmjs.org/dsh-mattpocock-skills-deck/latest',
      releaseBody('dsh-mattpocock-skills-deck', '2.0.0', 'https://registry.npmjs.org/')
    ),
    now: () => 1_000_000,
    randomId: () => 'check-1',
    nodeVersion: '22.0.0',
    ...overrides,
  }
}

describe('发行版识别（stable 冻结，预发布走新增口）', () => {
  it('validVersion 仍只认纯三段：预发布为假', () => {
    assert.equal(validVersion('1.2.3'), true)
    assert.equal(validVersion('0.2.0-rc.2'), false)
    assert.equal(validVersion('1.2'), false)
  })

  it('validReleaseVersion 收纯三段与预发布，拒非法', () => {
    assert.equal(validReleaseVersion('1.2.3'), true)
    assert.equal(validReleaseVersion('0.2.0-rc.2'), true)
    assert.equal(validReleaseVersion('1.0.0-alpha'), true)
    assert.equal(validReleaseVersion('1.0.0-alpha.1'), true)
    assert.equal(validReleaseVersion(''), false)
    assert.equal(validReleaseVersion('1.2'), false)
    assert.equal(validReleaseVersion('1.0.0-'), false)
    assert.equal(validReleaseVersion('1.0.0-01'), false)
    assert.equal(validReleaseVersion('1.0.0-rc.1+build'), false)
  })

  it('isPrereleaseVersion 只挑预发布', () => {
    assert.equal(isPrereleaseVersion('0.2.0-rc.2'), true)
    assert.equal(isPrereleaseVersion('1.2.3'), false)
    assert.equal(isPrereleaseVersion('xx'), false)
  })

  it('通道允许性：stable 只收纯三段，prerelease 两者皆收', () => {
    assert.equal(isVersionAllowedInChannel('1.2.3', 'stable'), true)
    assert.equal(isVersionAllowedInChannel('0.2.0-rc.2', 'stable'), false)
    assert.equal(isVersionAllowedInChannel('1.2.3', 'prerelease'), true)
    assert.equal(isVersionAllowedInChannel('0.2.0-rc.2', 'prerelease'), true)
  })
})

describe('发行版比较（SemVer §11）', () => {
  it('预发布小于同号正式版', () => {
    assert.equal(compareReleaseVersions('0.2.0-rc.2', '0.2.0'), -1)
    assert.equal(compareReleaseVersions('0.2.0', '0.2.0-rc.2'), 1)
  })

  it('预发布之间按标识符比：数字按数字，数字小于字母', () => {
    assert.equal(compareReleaseVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
    assert.equal(compareReleaseVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
    assert.equal(compareReleaseVersions('1.0.0-1', '1.0.0-alpha'), -1)
    assert.equal(compareReleaseVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
    assert.equal(compareReleaseVersions('1.0.0-rc.2', '1.0.0-rc.2'), 0)
  })

  it('纯三段比较与旧口径一致', () => {
    assert.equal(compareReleaseVersions('1.0.0', '2.0.0'), -1)
    assert.equal(compareReleaseVersions('2.0.0', '1.0.0'), 1)
    assert.equal(compareReleaseVersions('1.2.3', '1.2.3'), 0)
  })

  it('非法入参抛版本信息无效', () => {
    assert.throws(() => compareReleaseVersions('xx', '1.0.0'), /invalid-release/)
  })
})

describe('通道门：默认 stable，prerelease 显式 opt-in', () => {
  it('查新版默认不收预发布：远端预发布按版本信息无效处理', async () => {
    await assert.rejects(
      () =>
        fetchNpmRelease(
          fakeFetch(
            'https://registry.npmjs.org/dsh-mattpocock-skills-deck/latest',
            releaseBody('dsh-mattpocock-skills-deck', '0.2.0-rc.2', 'https://registry.npmjs.org/')
          ),
          10_000
        ),
      /invalid-release/
    )
  })

  it('prerelease 通道收预发布远端', async () => {
    const release = await fetchNpmRelease(
      fakeFetch(
        'https://registry.npmjs.org/dsh-mattpocock-skills-deck/latest',
        releaseBody('dsh-mattpocock-skills-deck', '0.2.0-rc.2', 'https://registry.npmjs.org/')
      ),
      10_000,
      { releaseChannel: 'prerelease' }
    )
    assert.equal(release.version, '0.2.0-rc.2')
  })

  it('核心默认通道：预发布远端不产出可装', async () => {
    const core = createUpdateCore(
      basePorts({
        fetchImpl: fakeFetch(
          'https://registry.npmjs.org/dsh-mattpocock-skills-deck/latest',
          releaseBody('dsh-mattpocock-skills-deck', '2.0.0-rc.1', 'https://registry.npmjs.org/')
        ),
      })
    )
    await assert.rejects(() => core.check(), /invalid-release/)
  })

  it('核心 prerelease 通道：预发布远端可装', async () => {
    const core = createUpdateCore(
      basePorts({
        releaseChannel: 'prerelease',
        fetchImpl: fakeFetch(
          'https://registry.npmjs.org/dsh-mattpocock-skills-deck/latest',
          releaseBody('dsh-mattpocock-skills-deck', '2.0.0-rc.1', 'https://registry.npmjs.org/')
        ),
      })
    )
    const result = await core.check()
    assert.equal(result.snapshot.latestVersion, '2.0.0-rc.1')
    assert.equal(result.snapshot.canInstall, true)
  })
})

describe('精确版锁定：通道只放宽“认不认”，不放宽“装什么”', () => {
  it('stable 通道配方不收预发布精确版', () => {
    assert.equal(installRecipe({ profileName: 'web', version: '1.2.3-rc.1', environmentKind: 'cli' }), null)
  })

  it('prerelease 通道配方收预发布精确版，参数仍是精确 spec', () => {
    const recipe = installRecipe({
      profileName: 'web',
      version: '1.2.3-rc.1',
      environmentKind: 'cli',
      releaseChannel: 'prerelease',
    })
    assert.deepEqual(recipe.pluginArgs, [
      'add',
      '--save-exact',
      'dsh-mattpocock-skills-deck@1.2.3-rc.1',
      '--registry=https://registry.npmjs.org/',
    ])
  })

  it('范围写法两个通道都不收', () => {
    assert.equal(installRecipe({ profileName: 'web', version: '^1.2.3', environmentKind: 'cli' }), null)
    assert.equal(
      installRecipe({ profileName: 'web', version: '^1.2.3', environmentKind: 'cli', releaseChannel: 'prerelease' }),
      null
    )
  })

  it('手工命令默认仍挑 stable 版', () => {
    const command = manualCommand({
      profileName: 'web',
      latestVersion: '1.2.3-rc.1',
      installedVersion: '1.0.0',
      runningVersion: '1.0.0',
      jobTargetVersion: null,
      blockedReason: null,
      sourceInstall: false,
    })
    assert.ok(command.includes('dsh-mattpocock-skills-deck@1.0.0'))
  })
})

describe('配置：releaseChannel 可选，默认 stable', () => {
  it('不传即 stable，与旧行为一致', () => {
    assert.equal(resolveUpdateConfig({ pluginId: 'p' }).releaseChannel, 'stable')
  })

  it('显式 prerelease 照收，非法值抛错', () => {
    assert.equal(resolveUpdateConfig({ pluginId: 'p', releaseChannel: 'prerelease' }).releaseChannel, 'prerelease')
    assert.throws(() => resolveUpdateConfig({ pluginId: 'p', releaseChannel: 'beta' }), /releaseChannel/)
  })
})

describe('跳过纯函数：按版本记、按版本清', () => {
  it('skipKey 即 插件标识@版本', () => {
    assert.equal(skipKey('my-plugin', '1.2.3'), 'my-plugin@1.2.3')
  })

  it('记一次即命中，同版本再记幂等', () => {
    const once = addSkipped([], '1.2.3', 100)
    assert.equal(isVersionSkipped(once, '1.2.3'), true)
    assert.equal(isVersionSkipped(once, '1.2.4'), false)
    const twice = addSkipped(once, '1.2.3', 200)
    assert.equal(twice.length, 1)
    assert.equal(twice[0].skippedAt, 200)
  })

  it('非法版本记不进去、查即不在', () => {
    assert.throws(() => addSkipped([], 'xx', 1), /install-failed/)
    assert.equal(isVersionSkipped([], 'xx'), false)
  })

  it('重置：给版本只清该版本，不给清全部', () => {
    const two = addSkipped(addSkipped([], '1.2.3', 1), '1.2.4', 2)
    assert.deepEqual(
      clearSkipped(two, '1.2.3').map((e) => e.version),
      ['1.2.4']
    )
    assert.deepEqual(clearSkipped(two), [])
  })

  it('归一化丢非法条目并封顶 50', () => {
    const raw = { skipped: [{ version: '1.0.0', skippedAt: 1 }, { version: 'xx' }, { version: '1.0.0', skippedAt: 2 }] }
    assert.deepEqual(normalizeSkipped(raw).map((e) => e.version), ['1.0.0'])
    const many = Array.from({ length: 60 }, (_, i) => ({ version: `1.0.${i}`, skippedAt: i }))
    assert.equal(normalizeSkipped({ skipped: many }).length, 50)
  })
})

let homeDir = ''
let profileDir = ''

before(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'dpu-skip-home-'))
  profileDir = mkdtempSync(join(tmpdir(), 'dpu-skip-profile-'))
})

after(() => {
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(profileDir, { recursive: true, force: true })
})

describe('跳过落盘：按插件隔离、坏文件自愈', () => {
  it('缺文件读回空，写后读回命中', async () => {
    const ports = createSkipDiskPorts(homeDir, 'skip-plugin', profileDir)
    assert.deepEqual(await ports.readSkipped(), [])
    await ports.writeSkipped(addSkipped([], '2.0.0', 123))
    const back = await ports.readSkipped()
    assert.equal(isVersionSkipped(back, '2.0.0'), true)
  })

  it('两插件各记各的，互不干扰', async () => {
    const a = createSkipDiskPorts(homeDir, 'plugin-a', profileDir)
    const b = createSkipDiskPorts(homeDir, 'plugin-b', profileDir)
    await a.writeSkipped(addSkipped([], '2.0.0', 1))
    await b.writeSkipped([])
    assert.equal(isVersionSkipped(await a.readSkipped(), '2.0.0'), true)
    assert.equal(isVersionSkipped(await b.readSkipped(), '2.0.0'), false)
  })

  it('重置版本落盘生效', async () => {
    const ports = createSkipDiskPorts(homeDir, 'reset-plugin', profileDir)
    await ports.writeSkipped(addSkipped(addSkipped([], '2.0.0', 1), '2.0.1', 2))
    const next = await ports.clearSkippedVersion('2.0.0')
    assert.deepEqual(next.map((e) => e.version), ['2.0.1'])
    assert.deepEqual(
      (await ports.readSkipped()).map((e) => e.version),
      ['2.0.1']
    )
  })
})
