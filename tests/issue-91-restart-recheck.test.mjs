/**
 * tests/issue-91-restart-recheck.test.mjs —— #91 重启后待重启应自动回查清零。
 *
 * 只测外部行为/产物，不碰实现细节；文案只认字典已有键（bilingual 零新增）。
 * 三条验收：
 * 1. 任务完成态换算落盘（restart-required→completed 写回，写失败不挡读数）。
 * 2. 批量账本重启后再验证（done+待重启在快照已生效时清零，真未生效时保留）。
 * 3. 只读失败不展示陈旧待重启（入口与单面板的新失败赢旧快照）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateCore } from '../dist/service.js'
import { entryStateKind } from '../dist/entry.js'
import { panelViewModel } from '../dist/panel.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

function eligibleEnv(installedVersion) {
  return {
    profileName: 'web',
    environmentKind: 'cli',
    homeDir: null,
    profileDir: null,
    installedVersion,
    packageValid: true,
    sourceInstall: false,
    blockedReason: null,
    installationKey: 'key-1',
    eligible: true,
  }
}

function basePorts(overrides = {}) {
  return {
    readRunningVersion: () => '1.0.1',
    readInstalled: async () => eligibleEnv('1.0.1'),
    fetchImpl: async () => {
      throw Object.assign(new Error('check-failed'), { code: 'check-failed' })
    },
    now: () => 1_000_000,
    randomId: () => 'id-1',
    nodeVersion: '22.0.0',
    ...overrides,
  }
}

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.1',
    installedVersion: '1.0.1',
    latestVersion: null,
    canInstall: false,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

describe('#91 任务完成态换算落盘', () => {
  it('重启后首次 status：运行版==目标版即换算成 completed 并写回', async () => {
    let stored = { id: 'j1', state: 'restart-required', targetVersion: '1.0.1', message: null, requestId: 'r1' }
    let writes = 0
    const core = createUpdateCore(
      basePorts({
        readRunningVersion: () => '1.0.1',
        readInstalled: async () => eligibleEnv('1.0.1'),
        readJob: async () => stored,
        writeJob: async (value) => {
          writes += 1
          stored = value
        },
      }),
    )
    const snap = await core.status()
    assert.equal(snap.job.state, 'completed')
    assert.equal(snap.blockedReason, null)
    assert.equal(writes, 1, '换算结果应落盘')
    assert.equal(stored.state, 'completed')
  })

  it('真未生效：运行版仍是旧版即保留 restart-required', async () => {
    let stored = { id: 'j1', state: 'restart-required', targetVersion: '1.0.1', message: null, requestId: 'r1' }
    const core = createUpdateCore(
      basePorts({
        readRunningVersion: () => '1.0.0',
        readInstalled: async () => eligibleEnv('1.0.1'),
        readJob: async () => stored,
        writeJob: async (value) => {
          stored = value
        },
      }),
    )
    const snap = await core.status()
    assert.equal(snap.job.state, 'restart-required')
    assert.equal(snap.blockedReason, 'pending-restart')
    assert.equal(stored.state, 'restart-required')
  })

  it('落盘写失败不挡读数：仍按换算后的快照展示', async () => {
    const core = createUpdateCore(
      basePorts({
        readRunningVersion: () => '1.0.1',
        readInstalled: async () => eligibleEnv('1.0.1'),
        readJob: async () => ({ id: 'j1', state: 'restart-required', targetVersion: '1.0.1', message: null, requestId: 'r1' }),
        writeJob: async () => {
          throw Object.assign(new Error('install-failed'), { code: 'install-failed' })
        },
      }),
    )
    const snap = await core.status()
    assert.equal(snap.job.state, 'completed')
    assert.equal(snap.blockedReason, null)
  })
})

describe('#91 只读失败不展示陈旧待重启', () => {
  it('入口：快照待重启 + 新失败码即失败态（新证据赢）', () => {
    const restartOnly = entryStateKind({ snapshot: baseSnapshot({ blockedReason: 'pending-restart' }), error: null })
    assert.equal(restartOnly, 'restart')
    const withError = entryStateKind({ snapshot: baseSnapshot({ blockedReason: 'pending-restart' }), error: 'check-failed' })
    assert.equal(withError, 'failed')
  })

  it('入口：任务失败 + 待重启标记并存即失败态', () => {
    const kind = entryStateKind({
      snapshot: baseSnapshot({
        blockedReason: 'pending-restart',
        job: { id: 'j', state: 'failed', targetVersion: '1.0.1', message: 'install-failed: x', requestId: 'r' },
      }),
      error: null,
    })
    assert.equal(kind, 'failed')
  })

  it('单面板：快照待重启 + 新失败锁存即失败横幅，否则待重启横幅', () => {
    const restart = panelViewModel({ snapshot: baseSnapshot({ blockedReason: 'pending-restart', latestVersion: '1.0.1', installedVersion: '1.0.1' }), manual: null, queue: null, skippedLatest: false, lastError: null })
    assert.equal(restart.banner.kind, 'restart')
    const failed = panelViewModel({ snapshot: baseSnapshot({ blockedReason: 'pending-restart', latestVersion: '1.0.1', installedVersion: '1.0.1' }), manual: null, queue: null, skippedLatest: false, lastError: 'check-failed' })
    assert.equal(failed.banner.kind, 'failed')
  })
})

describe('#91 批量账本重启后再验证', () => {
  async function tempScope() {
    const dir = await mkdtemp(join(tmpdir(), 'issue91-'))
    return { dir, scope: { homeDir: dir, profileDir: dir } }
  }
  function target(key) {
    return { key, title: '插件 ' + key, packageName: 'pkg-' + key, prefix: 'p-' + key }
  }
  function fakeTransportForInstall(restartRequired) {
    return {
      check: async () => ({ kind: 'update', version: '2.0.0' }),
      install: async () => ({ kind: 'done', restartRequired }),
    }
  }
  function overridesFor(running, installed, dir) {
    return {
      runningVersion: running,
      profileDir: dir ?? null,
      homeDir: dir ?? null,
      profileName: 'web',
      readInstalled: async () => ({
        profileName: 'web',
        environmentKind: 'cli',
        homeDir: dir ?? null,
        profileDir: dir ?? null,
        installedVersion: installed,
        packageValid: true,
        sourceInstall: false,
        blockedReason: installed !== running ? 'pending-restart' : null,
        installationKey: 'key-' + installed,
        eligible: installed === running,
      }),
      readJob: async () => null,
      writeJob: async () => {},
      tryAcquireLock: async () => true,
      releaseLock: async () => {},
      backupJob: async () => {},
      runInstall: async () => {},
      fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => '{}' }),
      now: () => 1000,
      randomId: () => 'id-1',
    }
  }

  it('重启已生效：done+待重启在运行版==目标版时清零', async () => {
    const { dir, scope } = await tempScope()
    const targets = [target('a')]
    // 第一程（重启前）：旧运行版下装完待重启。
    const host1 = createMultiHostUpdate(
      { scope, transport: fakeTransportForInstall(true), readerOverridesFor: () => overridesFor('1.0.0', '1.0.0', dir) },
      { prefix: 'life', targets },
    )
    const installed = await host1.handlers['life.batchInstall']({})
    assert.equal(installed.ok, true)
    assert.equal(installed.session.entries[0].phase, 'done')
    assert.equal(installed.session.entries[0].restartRequired, true)
    assert.equal(installed.session.entries[0].targetVersion, '2.0.0')
    host1.dispose()
    __resetSharedUpdateReaderForTests()
    // 第二程（重启后新进程）：磁盘与运行都是新版，首次 batchStatus 即回查清零。
    const host2 = createMultiHostUpdate(
      { scope, readerOverridesFor: () => overridesFor('2.0.0', '2.0.0', dir) },
      { prefix: 'life', targets },
    )
    const status = await host2.handlers['life.batchStatus']({})
    assert.equal(status.ok, true)
    assert.equal(status.session.entries[0].phase, 'done')
    assert.equal(status.session.entries[0].restartRequired, false, '已生效即清零，不靠手动检查')
    assert.equal(status.rows[0].restartRequired, false)
    host2.dispose()
  })

  it('真未生效：运行版仍是旧版即保留待重启', async () => {
    const { dir, scope } = await tempScope()
    const targets = [target('a')]
    const host1 = createMultiHostUpdate(
      { scope, transport: fakeTransportForInstall(true), readerOverridesFor: () => overridesFor('1.0.0', '1.0.0', dir) },
      { prefix: 'life', targets },
    )
    const installed = await host1.handlers['life.batchInstall']({})
    assert.equal(installed.session.entries[0].restartRequired, true)
    host1.dispose()
    __resetSharedUpdateReaderForTests()
    const host2 = createMultiHostUpdate(
      { scope, readerOverridesFor: () => overridesFor('1.0.0', '2.0.0', dir) },
      { prefix: 'life', targets },
    )
    const status = await host2.handlers['life.batchStatus']({})
    assert.equal(status.ok, true)
    assert.equal(status.session.entries[0].restartRequired, true, '真未生效继续提示待重启')
    assert.equal(status.rows[0].restartRequired, true)
    host2.dispose()
  })
})
