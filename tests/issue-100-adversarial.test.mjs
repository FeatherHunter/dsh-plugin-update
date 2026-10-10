/**
 * tests/issue-100-adversarial.test.mjs —— 对安装链的对抗式审查（#100 返工防御）。
 *
 * 只测外部行为：把宿主、注册源、时间、并发、脏数据能干的事各干一遍，
 * 断言本包要么做对、要么诚实失败——绝不静默装错版、绝不把异常漏出去、
 * 绝不崩溃。先红后绿：本文件第一版即全绿的项是钉子，不是漏洞。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateExecutor } from '../dist/store.js'
import { createUpdateCore } from '../dist/service.js'
import { installRecipe } from '../dist/commands.js'
import { mountUpdatePanel, panelViewModel } from '../dist/panel.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const RC_RUNNING = '1.8.0-rc.3'
const RC_LATEST = '1.8.0-rc.4'
const STABLE = '1.8.0'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'D'.repeat(86) + '=='
const MANAGER_KIND = 'desktop-manager'

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

function corePorts({ store, runInstall, installedVersionRef, remoteRef, nowRef, runningVersion = RC_RUNNING }) {
  return {
    readRunningVersion: () => runningVersion,
    readInstalled: async () => ({
      profileName: 'desktop',
      environmentKind: MANAGER_KIND,
      homeDir: null,
      profileDir: null,
      installedVersion: installedVersionRef.current,
      packageValid: true,
      sourceInstall: false,
      blockedReason: null,
      installationKey: 'key-adv',
      eligible: true,
    }),
    fetchImpl: async (url) => fakeLatest(remoteRef.current)(url),
    now: () => nowRef.current,
    randomId: (() => {
      let n = 0
      return () => `adv-${(n += 1)}`
    })(),
    nodeVersion: '22.0.0',
    releaseChannel: 'prerelease',
    readJob: store.readJob,
    writeJob: store.writeJob,
    tryAcquireLock: store.tryAcquireLock,
    releaseLock: store.releaseLock,
    backupJob: store.backupJob,
    runInstall,
  }
}

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now()
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------- A. 宿主回包 hostile ----------

describe('对抗：管理器回包再脏也不许漏出去', () => {
  const runWith = (manager, extra = {}) =>
    createUpdateExecutor({
      environmentKind: MANAGER_KIND,
      profileName: 'desktop',
      pluginId: 'adv',
      releaseChannel: 'prerelease',
      pluginManager: manager,
      log: () => {},
      ...extra,
    })
  const call = (runInstall) => runInstall({ version: RC_LATEST, profileName: 'desktop', environmentKind: MANAGER_KIND })

  it('A1 空对象回包：install-failed，不崩', async () => {
    const runInstall = runWith({ installBundle: () => Promise.resolve({}) })
    await assert.rejects(() => call(runInstall), (e) => e.code === 'install-failed')
  })

  it('A2 未知 application：install-failed 且带回原值', async () => {
    const runInstall = runWith({ installBundle: () => Promise.resolve({ application: 'weird' }) })
    await assert.rejects(
      () => call(runInstall),
      (e) => e.code === 'install-failed' && /weird/.test(e.detail ?? '')
    )
  })

  it('A3 failed 无 error：install-failed，不崩', async () => {
    const runInstall = runWith({ installBundle: () => Promise.resolve({ application: 'failed' }) })
    await assert.rejects(() => call(runInstall), (e) => e.code === 'install-failed')
  })

  it('A4 error 是纯字符串：收进详情', async () => {
    const runInstall = runWith({ installBundle: () => Promise.resolve({ application: 'failed', error: 'nope-code' }) })
    await assert.rejects(
      () => call(runInstall),
      (e) => e.code === 'install-failed' && /nope-code/.test(e.detail ?? '')
    )
  })

  it('A5 管理器抛裸字符串 / reject null：install-failed，不漏', async () => {
    for (const boom of [
      () => {
        throw 'bare-string'
      },
      () => Promise.reject(null),
    ]) {
      const runInstall = runWith({ installBundle: boom })
      await assert.rejects(() => call(runInstall), (e) => e.code === 'install-failed')
    }
  })

  it('A6 管理器装死：超时走取消路径，cancel 被调且只报 install-failed', async () => {
    const cancels = []
    const runInstall = runWith(
      {
        installBundle: () => new Promise(() => {}),
        cancelInstall: async () => {
          cancels.push(1)
          return { status: 'cancelled' }
        },
      },
      { installTimeoutMs: 20 }
    )
    await assert.rejects(
      () => call(runInstall),
      (e) => e.code === 'install-failed' && /超时/.test(e.detail ?? '')
    )
    assert.equal(cancels.length, 1)
  })

  it('A7 cancelled 不是成功：不许当装上', async () => {
    const runInstall = runWith({ installBundle: () => Promise.resolve({ application: 'cancelled' }) })
    await assert.rejects(() => call(runInstall), (e) => e.code === 'install-failed')
  })
})

// ---------- B. 竞态与边界（核心层） ----------

describe('对抗：竞态只许诚实失败，不许装错版', () => {
  it('B1 陈旧凭证：旧 checkId 只能换来 check-expired，盘不许动', async () => {
    const store = memoryStore()
    const installedVersionRef = { current: '1.8.0-rc.2' }
    const remoteRef = { current: RC_RUNNING }
    const nowRef = { current: 1_000_000 }
    let installs = 0
    const core = createUpdateCore(
      corePorts({
        store,
        installedVersionRef,
        remoteRef,
        nowRef,
        runningVersion: '1.8.0-rc.2',
        runInstall: async (args) => {
          installs += 1
          installedVersionRef.current = args.version
        },
      })
    )
    const c1 = await core.check()
    assert.equal(c1.snapshot.latestVersion, RC_RUNNING)
    remoteRef.current = RC_LATEST
    nowRef.current += 5000
    const c2 = await core.check()
    assert.equal(c2.snapshot.latestVersion, RC_LATEST)
    await assert.rejects(
      core.install({ checkId: c1.receipt.checkId, requestId: 'req-old' }),
      (e) => e.code === 'check-expired'
    )
    assert.equal(installedVersionRef.current, '1.8.0-rc.2')
    assert.equal(installs, 0)
    await core.install({ checkId: c2.receipt.checkId, requestId: 'req-new' })
    await waitFor(async () => installs === 1)
    assert.equal(installedVersionRef.current, RC_LATEST)
  })

  it('B2 凭证过期：绝不装，只报 check-expired', async () => {
    const store = memoryStore()
    const installedVersionRef = { current: RC_RUNNING }
    const remoteRef = { current: RC_LATEST }
    const nowRef = { current: 1_000_000 }
    let installs = 0
    const core = createUpdateCore(
      corePorts({ store, installedVersionRef, remoteRef, nowRef, runInstall: async () => {
        installs += 1
      } })
    )
    const c = await core.check()
    nowRef.current = 1_000_000 + 10 * 60_000 + 1
    await assert.rejects(core.install({ checkId: c.receipt.checkId, requestId: 'req-exp' }), (e) => e.code === 'check-expired')
    assert.equal(installs, 0)
  })

  it('B3 同版重装：无凭证可装，直接 check-expired，不调执行器', async () => {
    const store = memoryStore()
    const installedVersionRef = { current: RC_RUNNING }
    const remoteRef = { current: RC_RUNNING }
    const nowRef = { current: 1_000_000 }
    let installs = 0
    const core = createUpdateCore(
      corePorts({ store, installedVersionRef, remoteRef, nowRef, runInstall: async () => {
        installs += 1
      } })
    )
    const c = await core.check()
    assert.equal(c.snapshot.canInstall, false)
    assert.equal(c.receipt, null)
    await assert.rejects(core.install({ checkId: 'whatever', requestId: 'req-same' }), (e) => e.code === 'check-expired')
    assert.equal(installs, 0)
  })

  it('B4 幂等重放：同编号重复提交只跑一次执行器', async () => {
    const store = memoryStore()
    const installedVersionRef = { current: RC_RUNNING }
    const remoteRef = { current: RC_LATEST }
    const nowRef = { current: 1_000_000 }
    let installs = 0
    const core = createUpdateCore(
      corePorts({
        store,
        installedVersionRef,
        remoteRef,
        nowRef,
        runInstall: async (args) => {
          installs += 1
          installedVersionRef.current = args.version
        },
      })
    )
    const c = await core.check()
    await core.install({ checkId: c.receipt.checkId, requestId: 'req-dup' })
    await core.install({ checkId: c.receipt.checkId, requestId: 'req-dup' })
    await waitFor(async () => installs === 1)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(installs, 1)
  })

  it('B5 装完校验：管理器说装上了但盘没变，失败任务写明校验与目标', async () => {
    const store = memoryStore()
    const installedVersionRef = { current: RC_RUNNING }
    const remoteRef = { current: RC_LATEST }
    const nowRef = { current: 1_000_000 }
    const core = createUpdateCore(
      corePorts({ store, installedVersionRef, remoteRef, nowRef, runInstall: async () => {} })
    )
    const c = await core.check()
    await core.install({ checkId: c.receipt.checkId, requestId: 'req-verify' })
    const snap = await waitFor(async () => {
      const s = await core.status()
      return s.job && s.job.state === 'failed' ? s : null
    })
    assert.equal(snap.job.targetVersion, RC_LATEST)
    assert.match(snap.job.message ?? '', /装完校验/)
  })
})

// ---------- C. 配方矩阵 × 面板可达 ----------

describe('对抗：配方矩阵（三路由 × 双通道 × 双版本）', () => {
  const table = [
    ['cli', 'stable', '1.8.0', true],
    ['cli', 'stable', RC_LATEST, false],
    ['cli', 'prerelease', RC_LATEST, true],
    ['cli', 'prerelease', '1.8.0', true],
    ['desktop', 'stable', RC_LATEST, false],
    ['desktop', 'prerelease', RC_LATEST, true],
    [MANAGER_KIND, 'stable', RC_LATEST, false],
    [MANAGER_KIND, 'prerelease', RC_LATEST, true],
    [MANAGER_KIND, 'prerelease', '1.8.0', true],
  ]
  for (const [kind, channel, version, ok] of table) {
    it(`C1 ${kind} × ${channel} × ${version} → ${ok ? '有配方' : '无配方'}`, () => {
      const recipe = installRecipe({ profileName: 'desktop', version, environmentKind: kind, releaseChannel: channel })
      assert.equal(recipe !== null, ok)
      if (ok && channel === 'prerelease' && version === RC_LATEST) {
        assert.ok(recipe.pluginArgs.some((a) => String(a).includes(RC_LATEST)))
      }
    })
  }

  it('C2 面板可达：rc.4 可装页的按钮就是装 rc.4', () => {
    const view = panelViewModel(
      {
        snapshot: {
          runningVersion: RC_RUNNING, installedVersion: RC_RUNNING, latestVersion: RC_LATEST,
          canInstall: true, blockedReason: null, job: null,
        },
        manual: null, queue: null, skippedLatest: false, lastError: null,
        showOthers: false, pluginId: 'p', copyNotice: null, mode: 'embedded',
      },
      'zh'
    )
    assert.equal(view.banner.kind, 'update')
    assert.equal(view.installEnabled, true)
    assert.ok(view.installLabel.includes(RC_LATEST))
  })

  it(`C3 面板可达：stable 通道里 rc 版连按钮都不该有（无配方即无动作）`, () => {
    assert.equal(
      installRecipe({ profileName: 'desktop', version: RC_LATEST, environmentKind: MANAGER_KIND, releaseChannel: 'stable' }),
      null
    )
  })
})
