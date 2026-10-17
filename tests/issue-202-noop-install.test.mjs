/**
 * tests/issue-202-noop-install.test.mjs —— 空更新哨兵（#202，S2）。
 *
 * 真机批量行（2026-10-17 20:03）出现「目标版本 = 磁盘已装版本」的安装请求：
 * 批量编排在拿不到运行版时会把已装版当目标再发一次安装，白跑一趟宿主，还会把
 * 失败/待重启的状态搅浑。修形：安装入口在环境闸门之前认「目标与磁盘已装版相同」，
 * 直接按 `installation-changed` 诚实拒绝，且**不启动安装**（不建作业、不调 runInstall）。
 *
 * 只测外部行为（`dist/host.js` 公开电话回包）：
 * 1. 查完新版后磁盘被别处换成了目标版（真机同款竞态）⇒ 拒绝、细节说明无需安装、runInstall 零调用；
 * 2. 对照：目标确实比已装版新 ⇒ 正常走安装并落到待重启。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-noop-plugin'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='
const tmpRoots = []

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

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

function fakeLatest(remoteVersion) {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(TARGET)}/latest`)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: TARGET,
          version: remoteVersion,
          engines: { node: '>=22' },
          dist: { tarball: `${REGISTRY}${TARGET}/-/demo-noop-plugin-${remoteVersion}.tgz`, integrity: INTEGRITY },
        }),
    }
  }
}

/**
 * 建宿主：运行版与磁盘已装版同号（检查期状态自洽），远端最新 `remote`；
 * `apply` 记录安装真的被调起的次数并改盘。
 */
function makeHost({ installed, remote }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-202-'))
  tmpRoots.push(profileDir)
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: `^${installed}` },
  })
  makeTargetPackage(join(profileDir, 'node_modules', TARGET), installed)
  const runCalls = []
  const host = createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion: installed,
        targetPackageDir: join(profileDir, 'node_modules', TARGET),
        profileDir,
        profileName: 'desktop',
        homeDir: profileDir,
        fetchImpl: fakeLatest(remote),
        now: () => 1_000_000,
        randomId: () => `id-${runCalls.length + 1}`,
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        runInstall: async ({ version }) => {
          runCalls.push(version)
          makeTargetPackage(join(profileDir, 'node_modules', TARGET), version)
        },
        ...memoryStore(),
      },
    },
    { pluginId: 'issue-202-plugin', prefix: 'issue202', targetPackageName: TARGET },
  )
  return { host, runCalls, profileDir }
}

async function waitTerminal(host) {
  for (let i = 0; i < 100; i += 1) {
    const status = await host.handlers['issue202.updateStatus']({})
    const job = status && status.snapshot ? status.snapshot.job : null
    if (job && (job.state === 'restart-required' || job.state === 'completed' || job.state === 'failed')) return status.snapshot
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('作业没有在 2 秒内落到终态')
}

describe('#202 空更新哨兵：目标与已装版相同不启动安装', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })
  after(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('查完后磁盘已被换成目标版：installation-changed、说明无需安装、runInstall 一次都不调', async () => {
    const { host, runCalls, profileDir } = makeHost({ installed: '0.3.53', remote: '0.3.54' })
    const check = await host.handlers['issue202.updateCheck']({})
    assert.equal(check.ok, true)
    assert.ok(check.receipt && typeof check.receipt.checkId === 'string', '查新版必须带回执')
    // 竞态：用户拿到回执之后、点安装之前，磁盘版本已经被别处换成了目标版。
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), '0.3.54')
    const out = await host.handlers['issue202.updateInstall']({
      checkId: check.receipt.checkId,
      requestId: 'req-noop-1',
    })
    assert.equal(out.ok, false)
    assert.equal(out.error, 'installation-changed')
    assert.match(JSON.stringify(out), /无需安装/)
    assert.deepEqual(runCalls, [], '空更新绝不能真的调起安装')
  })

  it('对照：目标确实比已装版新 ⇒ 正常走安装并落到待重启', async () => {
    const { host, runCalls } = makeHost({ installed: '0.3.53', remote: '0.3.54' })
    const check = await host.handlers['issue202.updateCheck']({})
    assert.equal(check.ok, true)
    const out = await host.handlers['issue202.updateInstall']({
      checkId: check.receipt.checkId,
      requestId: 'req-real-1',
    })
    assert.equal(out.ok, true)
    const snapshot = await waitTerminal(host)
    assert.equal(snapshot.job.state, 'restart-required')
    assert.deepEqual(runCalls, ['0.3.54'])
  })
})
