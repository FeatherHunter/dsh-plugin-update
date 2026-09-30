/**
 * tests/desktop-manager.test.mjs —— 第三条安装路由（官方桌面版的进程内插件管理器）。
 *
 * 只测外部行为：宿主种类怎么认、配方交给管理器的是什么、成败怎么归类、失败原话怎么收敛。
 * 管理器、网络、落盘全用假件；不碰真机、不起进程、不联网。
 *
 * 厂商契约（取值与形状）出处见 docs/host-install-exits.md；本文件只断言本包的行为。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, detectEnvironmentKind, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { resolveProfileName } from '../dist/reader.js'
import { installRecipe } from '../dist/commands.js'
import { createUpdateExecutor } from '../dist/store.js'

const RELEASE_VERSION = '9.9.9'
const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const PROFILE_DIR = 'C:\\fake\\profiles\\desktop'
const MANAGER_KIND = 'desktop-manager'

const ctxWith = (services) => ({ get: (name) => services[name] })

function fakeRelease(targetName = TARGET) {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(targetName)}/latest`)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: targetName,
          version: RELEASE_VERSION,
          engines: { node: '>=22' },
          dist: {
            tarball: `${REGISTRY}${targetName}/-/${targetName}-${RELEASE_VERSION}.tgz`,
            integrity: 'sha512-' + 'A'.repeat(86) + '==',
          },
        }),
    }
  }
}

function memoryStore() {
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
  }
}

/** 官方桌面版下读环境会看到的形状：走管理器的宿主种类 + 名字恰是 desktop。 */
function managerEnv(installedVersion) {
  return {
    profileName: 'desktop',
    environmentKind: MANAGER_KIND,
    homeDir: 'C:\\fake\\home',
    profileDir: PROFILE_DIR,
    installedVersion,
    packageValid: true,
    sourceInstall: false,
    blockedReason: null,
    installationKey: 'fake-key',
    eligible: true,
  }
}

describe('宿主种类探测（顺序固定，老路不变）', () => {
  const manager = { installBundle: () => {} }

  it('有 desktopProfiles 就是 desktop：第三方 Desktop 一字不变', () => {
    assert.equal(detectEnvironmentKind(ctxWith({ desktopProfiles: {}, pluginManager: manager }), 'desktop'), 'desktop')
  })

  it('没有桌面服务、有管理器、名字恰是命令行封禁的 desktop 才算 desktop-manager（大小写不敏感）', () => {
    const ctx = ctxWith({ pluginManager: manager })
    assert.equal(detectEnvironmentKind(ctx, 'desktop'), MANAGER_KIND)
    assert.equal(detectEnvironmentKind(ctx, 'Desktop'), MANAGER_KIND)
  })

  it('名字不是 desktop、没给名字、管理器形状不对、没有 ctx：一律按 cli（不猜）', () => {
    const ctx = ctxWith({ pluginManager: manager })
    assert.equal(detectEnvironmentKind(ctx, 'web'), 'cli')
    assert.equal(detectEnvironmentKind(ctx), 'cli')
    // 判据与命令行同一份（不做 trim）：带空格的写法命令行不会拒绝，这里也不认。
    assert.equal(detectEnvironmentKind(ctx, 'desktop '), 'cli')
    assert.equal(detectEnvironmentKind(ctxWith({ pluginManager: {} }), 'desktop'), 'cli')
    assert.equal(detectEnvironmentKind(ctxWith({}), 'desktop'), 'cli')
    assert.equal(detectEnvironmentKind(null, 'desktop'), 'cli')
  })

  it('名字与读环境同一口径：调用方给了就用它，否则取使用范围目录最后一段', () => {
    assert.equal(resolveProfileName(undefined, PROFILE_DIR), 'desktop')
    assert.equal(resolveProfileName(null, PROFILE_DIR), 'desktop')
    assert.equal(resolveProfileName('given', PROFILE_DIR), 'given')
  })
})

describe('第三条路由的配方（管理器只吃一个 spec 字符串）', () => {
  it('desktop-manager：参数只有 add 与精确版本规格，不带开关也不带源', () => {
    const recipe = installRecipe({ profileName: 'desktop', version: '1.2.3', environmentKind: MANAGER_KIND })
    assert.equal(recipe.route, MANAGER_KIND)
    assert.deepEqual(recipe.pluginArgs, ['add', `${TARGET}@1.2.3`])
    assert.equal(recipe.timeoutMs, 15 * 60_000)
    assert.equal(recipe.version, '1.2.3')
  })

  it('包名不合管理器规格就不给配方（诚实失败转手工命令），不猜', () => {
    assert.equal(
      installRecipe({ profileName: 'desktop', version: '1.2.3', environmentKind: MANAGER_KIND, targetPackageName: 'Bad-Name' }),
      null
    )
  })

  it('另两条老路的参数形状一字不变', () => {
    assert.deepEqual(installRecipe({ profileName: 'web', version: '1.2.3', environmentKind: 'cli' }).pluginArgs, [
      'add',
      '--save-exact',
      `${TARGET}@1.2.3`,
      `--registry=${REGISTRY}`,
    ])
    assert.equal(installRecipe({ profileName: 'web', version: '1.2.3', environmentKind: 'desktop' }).route, 'desktop-service')
  })
})

describe('管理器执行器（假件）', () => {
  const runWith = (parts) =>
    createUpdateExecutor({ environmentKind: MANAGER_KIND, profileName: 'desktop', pluginId: 'my-plugin', ...parts })
  const call = (runInstall) => runInstall({ version: '1.2.3', profileName: 'desktop', environmentKind: MANAGER_KIND })

  it('成功三态都算成功：spec 与 requestId 原样交给管理器，源走 registry 选项', async () => {
    for (const application of ['applied', 'restart-required', 'overridden']) {
      const seen = []
      const fires = []
      const runInstall = runWith({
        registryUrl: REGISTRY,
        pluginManager: {
          installBundle: (spec, options) => {
            seen.push({ spec, options })
            return Promise.resolve({ application })
          },
        },
        log: (level, event, fields) => fires.push({ level, event, fields }),
      })
      await call(runInstall)
      assert.equal(seen.length, 1)
      assert.equal(seen[0].spec, `${TARGET}@1.2.3`)
      assert.equal(typeof seen[0].options.requestId, 'string')
      assert.ok(seen[0].options.requestId.length > 0)
      assert.equal(seen[0].options.registry, REGISTRY)
      const exec = fires.filter((f) => f.event === 'update.install.exec')
      assert.equal(exec.length, 1)
      assert.equal(exec[0].fields.route, MANAGER_KIND)
      assert.equal(exec[0].fields.ok, true)
      assert.deepEqual(Object.keys(exec[0].fields).sort(), ['durationMs', 'exitCode', 'ok', 'pluginId', 'route'])
    }
  })

  it('失败不 reject 也算失败：error 收成一行人话（脱敏 + 截断）', async () => {
    const runInstall = runWith({
      pluginManager: {
        installBundle: () =>
          Promise.resolve({
            application: 'failed',
            error: { code: 'operation-error', diagnostic: `pnpm 说装不上 C:\\secret\\deep\\place ${'x'.repeat(400)}` },
          }),
      },
      log: () => {},
    })
    await assert.rejects(
      () => call(runInstall),
      (error) => {
        assert.equal(error.code, 'install-failed')
        assert.match(error.detail, /operation-error/)
        assert.ok(!error.detail.includes('C:\\secret'), '绝对路径必须脱敏')
        assert.ok(error.detail.length <= 301, '详情必须截断')
        return true
      }
    )
  })

  it('管理器形状不对、包名不合规格：诚实失败，不试别的形状', async () => {
    await assert.rejects(() => call(runWith({ pluginManager: {}, log: () => {} })), /install-failed/)
    const mustNot = { installBundle: () => assert.fail('管理器不该被调用') }
    await assert.rejects(
      () => call(runWith({ pluginManager: mustNot, targetPackageName: 'Bad-Name', log: () => {} })),
      /install-failed/
    )
  })

  it('没注入源就不传源（由管理器用自己的源策略），注入了就原样交给它', async () => {
    const seen = []
    const manager = {
      installBundle: (spec, options) => {
        seen.push(options)
        return Promise.resolve({ application: 'applied' })
      },
    }
    await call(runWith({ pluginManager: manager, log: () => {} }))
    assert.equal('registry' in seen[0], false)
    await call(runWith({ pluginManager: manager, registryUrl: REGISTRY, log: () => {} }))
    assert.equal(seen[1].registry, REGISTRY)
  })

  it('超时：先请求取消，再按失败收场（详情说明超时）', async () => {
    let cancelled = null
    const runInstall = runWith({
      installTimeoutMs: 30,
      pluginManager: {
        installBundle: () => new Promise(() => {}),
        cancelInstall: (requestId) => {
          cancelled = requestId
          return Promise.resolve({ status: 'cancelled' })
        },
      },
      log: () => {},
    })
    await assert.rejects(() => call(runInstall), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.match(error.detail, /超时/)
      return true
    })
    assert.equal(typeof cancelled, 'string')
  })

  it('超时但管理器说太晚（too-late）：等它自己结束，再按 application 判成功', async () => {
    const runInstall = runWith({
      installTimeoutMs: 20,
      pluginManager: {
        installBundle: () => new Promise((settle) => setTimeout(() => settle({ application: 'applied' }), 60)),
        cancelInstall: () => Promise.resolve({ status: 'too-late' }),
      },
      log: () => {},
    })
    await call(runInstall)
  })

  it('超时撞上「刚好装完」的竞态：取消说没在跑，也按它自己的结局判成功，不把落地的改动记成失败', async () => {
    const runInstall = runWith({
      installTimeoutMs: 20,
      pluginManager: {
        installBundle: () => new Promise((settle) => setTimeout(() => settle({ application: 'applied' }), 40)),
        cancelInstall: () => Promise.resolve({ status: 'not-running' }),
      },
      log: () => {},
    })
    await call(runInstall)
  })

  it('超时且管理器一直不落定：终止宽限期过后诚实失败，详情说明超时', async () => {
    const runInstall = runWith({
      installTimeoutMs: 20,
      pluginManager: { installBundle: () => new Promise(() => {}) },
      log: () => {},
    })
    await assert.rejects(() => call(runInstall), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.match(error.detail, /超时/)
      return true
    })
  })

  it('超时后取消成功：报「安装已被取消」，不报成宿主报错', async () => {
    const runInstall = runWith({
      installTimeoutMs: 20,
      pluginManager: {
        installBundle: () => new Promise((settle) => setTimeout(() => settle({ application: 'cancelled' }), 30)),
        cancelInstall: () => Promise.resolve({ status: 'cancelled' }),
      },
      log: () => {},
    })
    await assert.rejects(() => call(runInstall), (error) => {
      assert.match(error.detail, /取消/)
      return true
    })
  })
})

describe('端到端：官方桌面版从查到装（假 ctx 与假管理器）', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })

  function makeHost(manager, installed) {
    return createHostUpdate(
      {
        ctx: ctxWith({ pluginManager: manager }),
        readerOverrides: {
          runningVersion: '1.0.0',
          profileDir: PROFILE_DIR,
          homeDir: 'C:\\fake\\home',
          fetchImpl: fakeRelease(),
          now: () => 1_000_000,
          randomId: (() => {
            let n = 0
            return () => `id-${(n += 1)}`
          })(),
          nodeVersion: '22.0.0',
          readInstalled: async () => managerEnv(installed.value),
          ...memoryStore(),
        },
      },
      { pluginId: 'dsh-mattpocock-skills-deck' }
    )
  }

  async function waitForJob(host, state) {
    for (let i = 0; i < 400; i += 1) {
      const out = await host.handlers['wf.updateStatus']({})
      if (out.snapshot.job && out.snapshot.job.state === state) return out.snapshot.job
      await new Promise((settle) => setTimeout(settle, 5))
    }
    throw new Error(`job 没走到 ${state}`)
  }

  it('查到新版 → 装上 → 管理器收到精确规格 → 磁盘版本变了即算成功', async () => {
    const installed = { value: '1.0.0' }
    const seen = []
    const manager = {
      installBundle: (spec, options) => {
        seen.push({ spec, options })
        installed.value = RELEASE_VERSION
        return Promise.resolve({ application: 'applied' })
      },
    }
    const host = makeHost(manager, installed)
    const check = await host.handlers['wf.updateCheck']({})
    assert.equal(check.snapshot.latestVersion, RELEASE_VERSION)
    await host.handlers['wf.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-1' })
    const job = await waitForJob(host, 'restart-required')
    assert.equal(job.targetVersion, RELEASE_VERSION)
    assert.deepEqual(
      seen.map((s) => s.spec),
      [`${TARGET}@${RELEASE_VERSION}`]
    )
    assert.equal(seen[0].options.registry, REGISTRY)
  })

  it('宿主说失败：已有 message 通道带上宿主原话（字段集与形状不变）', async () => {
    const installed = { value: '1.0.0' }
    const manager = {
      installBundle: () =>
        Promise.resolve({
          application: 'failed',
          error: { code: 'operation-error', diagnostic: 'pnpm 报错 C:\\Users\\someone\\secret' },
        }),
    }
    const host = makeHost(manager, installed)
    const check = await host.handlers['wf.updateCheck']({})
    await host.handlers['wf.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-2' })
    const job = await waitForJob(host, 'failed')
    assert.match(job.message, /^install-failed: /)
    assert.match(job.message, /operation-error/)
    assert.ok(!job.message.includes('C:\\Users\\someone\\secret'), '回给用户的详情里不带绝对路径')
  })

  it('宿主说成功但磁盘没变：装完校验也要给出能读的说明，不是死码', async () => {
    const installed = { value: '1.0.0' }
    const manager = { installBundle: () => Promise.resolve({ application: 'applied' }) }
    const host = makeHost(manager, installed)
    const check = await host.handlers['wf.updateCheck']({})
    await host.handlers['wf.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-3' })
    const job = await waitForJob(host, 'failed')
    assert.match(job.message, /^install-failed: /)
    assert.match(job.message, /装完校验没过/)
  })
})
