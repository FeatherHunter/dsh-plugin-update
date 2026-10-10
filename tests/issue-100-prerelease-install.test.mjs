/**
 * tests/issue-100-prerelease-install.test.mjs —— prerelease 通道在安装执行路径上丢失。
 *
 * 只测外部行为：查新版走 prerelease 通道看得到 rc，但安装执行（executor / service /
 * host 默认链路）把 releaseChannel 弄丢，回落 stable，于是任何预发布精确版都
 * `install-failed` 且无详情（!recipe 分支不带 detail）。
 * 另 cover 面板侧：新版本到达即清旧失败锁存（#58 常驻只保同上下文）。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createUpdateExecutor } from '../dist/store.js'
import { createUpdateCore } from '../dist/service.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { mountUpdatePanel } from '../dist/panel.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const RC_RUNNING = '1.8.0-rc.3'
const RC_LATEST = '1.8.0-rc.4'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'D'.repeat(86) + '=='
const MANAGER_KIND = 'desktop-manager'

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

function makeRcProfile() {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-100-'))
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: RC_RUNNING },
  })
  const targetDir = join(profileDir, 'node_modules', TARGET)
  writeJson(join(targetDir, 'package.json'), {
    name: TARGET,
    version: RC_RUNNING,
    main: './index.js',
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './patch.js' } },
  })
  writeFileSync(join(targetDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(join(targetDir, 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(targetDir, 'patch.js'), 'module.exports = {}\n')
  return profileDir
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

const tmpRoots = []
beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #100：执行器必须透传版本通道', () => {
  const runWith = (parts) =>
    createUpdateExecutor({ environmentKind: MANAGER_KIND, profileName: 'desktop', pluginId: 'issue-100', ...parts })

  it('prerelease 通道 + rc 精确版：管理器拿到完整 spec', async () => {
    const seen = []
    const runInstall = runWith({
      releaseChannel: 'prerelease',
      pluginManager: {
        installBundle: (spec, options) => {
          seen.push({ spec, options })
          return Promise.resolve({ application: 'applied' })
        },
      },
      log: () => {},
    })
    await runInstall({ version: RC_LATEST, profileName: 'desktop', environmentKind: MANAGER_KIND })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].spec, `${TARGET}@${RC_LATEST}`)
  })

  it('缺省仍是 stable：rc 精确版无配方（旧行为钉住）', async () => {
    const runInstall = runWith({
      pluginManager: { installBundle: () => Promise.resolve({ application: 'applied' }) },
      log: () => {},
    })
    await assert.rejects(
      () => runInstall({ version: RC_LATEST, profileName: 'desktop', environmentKind: MANAGER_KIND }),
      (error) => error.code === 'install-failed'
    )
  })
})

describe('issue #100：核心必须把通道交到执行器手里', () => {
  function basePorts({ store, runInstall, installedVersionRef }) {
    return {
      readRunningVersion: () => RC_RUNNING,
      readInstalled: async () => ({
        profileName: 'desktop',
        environmentKind: MANAGER_KIND,
        homeDir: null,
        profileDir: null,
        installedVersion: installedVersionRef.current,
        packageValid: true,
        sourceInstall: false,
        blockedReason: null,
        installationKey: 'key-100',
        eligible: true,
      }),
      fetchImpl: fakeLatest(RC_LATEST),
      now: () => 1_000_000,
      randomId: (() => {
        let n = 0
        return () => `core-100-${(n += 1)}`
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

  it('查到 rc.4 并安装：runInstall 收到的参数里必须有 prerelease 通道', async () => {
    const store = memoryStore()
    const installedVersionRef = { current: RC_RUNNING }
    let seenArgs = null
    const core = createUpdateCore(
      basePorts({
        store,
        installedVersionRef,
        runInstall: async (args) => {
          seenArgs = args
          installedVersionRef.current = args.version
        },
      })
    )
    const checked = await core.check()
    assert.equal(checked.snapshot.latestVersion, RC_LATEST)
    assert.equal(checked.snapshot.canInstall, true)
    await core.install({ checkId: checked.receipt.checkId, requestId: 'req-100' })
    const start = Date.now()
    while (!seenArgs) {
      if (Date.now() - start > 2000) throw new Error('runInstall 一直没被调到')
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(seenArgs.version, RC_LATEST)
    assert.equal(seenArgs.releaseChannel, 'prerelease')
  })
})

describe('issue #100：host 默认链路端到端（查见 rc.4 → 装 rc.4 的 spec 到管理器）', () => {
  it('最小复现：updateCheck 后 updateInstall，管理器收到的就是 rc.4', async () => {
    const profileDir = makeRcProfile()
    tmpRoots.push(profileDir)
    const seen = []
    const host = createHostUpdate(
      {
        logCtx: { fire: () => {} },
        readerOverrides: {
          targetPackageDir: join(profileDir, 'node_modules', TARGET),
          profileDir,
          profileName: 'desktop',
          homeDir: profileDir,
          fetchImpl: fakeLatest(RC_LATEST),
          now: () => 1_000_000,
          randomId: () => 'id-100',
          nodeVersion: '22.0.0',
          environmentKind: MANAGER_KIND,
          targetPackageName: TARGET,
          pluginManager: {
            installBundle: (spec, options) => {
              seen.push({ spec, options })
              return Promise.resolve({ application: 'applied' })
            },
          },
          ...memoryStore(),
        },
      },
      { pluginId: 'issue-100-plugin', prefix: 'issue100', targetPackageName: TARGET, releaseChannel: 'prerelease' }
    )
    const checked = await host.handlers['issue100.updateCheck']({})
    assert.equal(checked.ok, true)
    assert.equal(checked.snapshot.latestVersion, RC_LATEST)
    assert.equal(checked.snapshot.canInstall, true)
    const installed = await host.handlers['issue100.updateInstall']({
      checkId: checked.receipt.checkId,
      requestId: 'req-100',
    })
    assert.equal(installed.ok, true)
    const start = Date.now()
    while (seen.length === 0) {
      if (Date.now() - start > 2000) throw new Error('管理器一直没收到安装请求')
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(seen[0].spec, `${TARGET}@${RC_LATEST}`)
    assert.equal(installed.snapshot.job.targetVersion, RC_LATEST)
  })
})

// ---------- 面板：新版本到达即清旧失败 ----------

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function failedJobRc3() {
  return { id: 'job-100', state: 'failed', targetVersion: RC_RUNNING, message: 'install-failed: x', requestId: 'req-100' }
}

function snapTriple(job, latest) {
  return {
    runningVersion: RC_RUNNING,
    installedVersion: RC_RUNNING,
    latestVersion: latest,
    canInstall: true,
    blockedReason: null,
    job,
  }
}

const okQueue = () => ({ busy: false, owner: null, waiting: [], position: null })

describe('issue #100：新版本到达，旧失败横幅必须让位', () => {
  it('同上下文常驻，但三元组一变（远端出 rc.4）即清除', async () => {
    const state = { phase: 'idle' }
    const texts = []
    const call = async (name) => {
      if (name.endsWith('.updateStatus')) {
        if (state.phase === 'idle') {
          return { ok: true, snapshot: snapTriple(null, RC_RUNNING), manual: null, queue: okQueue() }
        }
        return { ok: true, snapshot: snapTriple(failedJobRc3(), state.phase === 'new' ? RC_LATEST : RC_RUNNING), manual: null, queue: okQueue() }
      }
      if (name.endsWith('.updateCheck')) {
        return { ok: true, snapshot: snapTriple(null, RC_RUNNING), manual: null, receipt: { checkId: 'c-100', checkedAt: 1, expiresAt: 9999999999999 }, queue: okQueue() }
      }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdatePanel(box, { pluginId: 'issue-100', call, pollMs: 60000, copyText: async (t) => texts.push(t), autoChangelog: false })
    const settled = async () => new Promise((r) => setTimeout(r, 20))
    await settled()
    await settled()
    // 旧失败到达：常驻
    state.phase = 'old'
    await panel.refresh()
    await settled()
    assert.match(box.innerHTML, /更新失败/, '旧失败应锁存')
    assert.match(box.innerHTML, /失败目标 1\.8\.0-rc\.3/, '旧失败应写明目标版')
    await panel.refresh()
    await settled()
    assert.match(box.innerHTML, /更新失败/, '同上下文轮询不清除（#58 常驻仍在）')
    // 新版本到达：失败让位
    state.phase = 'new'
    await panel.refresh()
    await settled()
    assert.doesNotMatch(box.innerHTML, /更新失败/, '远端出 rc.4 后旧失败横幅必须消失')
    assert.match(box.innerHTML, /有新版.*可装/, '回到 rc.4 可装页')
    panel.unmount()
  })
})
