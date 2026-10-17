/**
 * tests/issue-202-noop-install.test.mjs —— 空更新哨兵（#202，S2）。
 *
 * 真机批量行（2026-10-17 20:03）出现「目标版本 = 磁盘已装版本」的安装请求：
 * 批量编排在拿不到运行版时会把已装版当目标再发一次安装，白跑一趟宿主，还会把
 * 失败/待重启的状态搅浑。修形：安装入口在环境闸门之前认「目标与磁盘已装版相同」，
 * 直接按 `installation-changed` 诚实拒绝，且**不启动安装**（不建作业、不调 runInstall）。
 *
 * 只测外部行为（`dist/host.js` 公开电话回包）：
 * 1. 查完新版后磁盘被别处换成了目标版（真机同款竞态）⇒ 拒绝、细节说明无需安装、不建任务、runInstall 零调用；
 * 2. 过了入口哨兵、等锁期间磁盘被换成目标版（锁后重读竞态）⇒ 同样拒绝且不启动安装；
 * 3. 对照：目标确实比已装版新 ⇒ 正常走安装并落到待重启；
 * 4. 候选（合规版）路径同款锁后竞态 ⇒ 同样拒绝（哨兵必须与 latest 路径同序：在指纹/环境闸门之前）；
 * 5. 对照：候选路径磁盘没被换 ⇒ 正常安装候选版并落到待重启。
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
 * `apply` 记录安装真的被调起的次数并改盘。`mutateOnRefetch` 让第 2 次取远端时把磁盘换成目标版，
 * 用来复现「过了入口哨兵、等锁/重取期间磁盘被别处换成了目标版」的竞态。
 */
function makeHost({ installed, remote, mutateOnRefetch = false }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-202-'))
  tmpRoots.push(profileDir)
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: `^${installed}` },
  })
  makeTargetPackage(join(profileDir, 'node_modules', TARGET), installed)
  const runCalls = []
  let fetches = 0
  const latest = fakeLatest(remote)
  const host = createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion: installed,
        targetPackageDir: join(profileDir, 'node_modules', TARGET),
        profileDir,
        profileName: 'desktop',
        homeDir: profileDir,
        fetchImpl: async (url) => {
          fetches += 1
          if (mutateOnRefetch && fetches === 2) makeTargetPackage(join(profileDir, 'node_modules', TARGET), remote)
          return latest(url)
        },
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

async function waitTerminal(host, prefix = 'issue202') {
  for (let i = 0; i < 100; i += 1) {
    const status = await host.handlers[`${prefix}.updateStatus`]({})
    const job = status && status.snapshot ? status.snapshot.job : null
    if (job && (job.state === 'restart-required' || job.state === 'completed' || job.state === 'failed')) return status.snapshot
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('作业没有在 2 秒内落到终态')
}

// ---------- 候选（合规版）路径 #202 竞态 ----------

const RUNNING = '0.3.52'
const CANDIDATE = '0.3.53'
const TARGET_VERSION = '0.3.54'
const DAY = 86_400_000
const NOW = 1_000_000_000_000

/**
 * 候选安装宿主：远端 latest 0.3.54 发布才 3 天、被 7 天年龄门挡住；老版 0.3.53 满门限，
 * 于是 `updateCheckFallback` 给 `downgrade-available` 候选 0.3.53（严格新于运行版 0.3.52）。
 * `mutateBeforeLockRead`：在候选路径**最后一次重取版本文档**时把磁盘换成候选版——此刻入口
 * 哨兵已过、锁后重读还没发生，正是「等锁期间磁盘被别处换成目标版」的真机同款竞态。
 */
function makeCandidateHost({ mutateBeforeLockRead = false } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-202c-'))
  tmpRoots.push(profileDir)
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: `^${RUNNING}` },
  })
  makeTargetPackage(join(profileDir, 'node_modules', TARGET), RUNNING)
  const packument = {
    name: TARGET,
    'dist-tags': { latest: TARGET_VERSION },
    time: {
      [RUNNING]: new Date(NOW - 30 * DAY).toISOString(),
      [CANDIDATE]: new Date(NOW - 10 * DAY).toISOString(),
      [TARGET_VERSION]: new Date(NOW - 3 * DAY).toISOString(),
    },
  }
  const releaseDoc = (version) => ({
    name: TARGET,
    version,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/demo-noop-plugin-${version}.tgz`, integrity: INTEGRITY },
  })
  const answer = (body) => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) })
  let versionDocFetches = 0
  const runCalls = []
  const runArgs = []
  const host = createHostUpdate(
    {
      readerOverrides: {
        runningVersion: RUNNING,
        targetPackageDir: join(profileDir, 'node_modules', TARGET),
        profileDir,
        profileName: 'desktop',
        homeDir: profileDir,
        fetchImpl: async (url) => {
          if (url.endsWith(encodeURIComponent(CANDIDATE))) {
            versionDocFetches += 1
            if (mutateBeforeLockRead && versionDocFetches === 2) {
              makeTargetPackage(join(profileDir, 'node_modules', TARGET), CANDIDATE)
            }
            return answer(releaseDoc(CANDIDATE))
          }
          return answer(packument)
        },
        now: () => NOW,
        randomId: () => `id-${runCalls.length + 1}`,
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        runInstall: async (args) => {
          const { version } = args
          runCalls.push(version)
          runArgs.push(args)
          makeTargetPackage(join(profileDir, 'node_modules', TARGET), version)
        },
        ...memoryStore(),
      },
    },
    { pluginId: 'issue-202-candidate-plugin', prefix: 'issue202c', targetPackageName: TARGET },
  )
  return { host, runCalls, runArgs }
}

async function askCandidate(host) {
  return host.handlers['issue202c.updateCheckFallback']({
    kind: 'minimum-release-age',
    blame: 'target',
    targetVersion: TARGET_VERSION,
    windowMs: 7 * DAY,
    windowSource: 'message',
  })
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
    assert.equal(out.diag && out.diag.detail, '目标版本与已装版本相同，无需安装', '失败详情必须精确说明「无需安装」')
    assert.equal('snapshot' in out, false, '空更新不建任务：失败回包不该带快照')
    assert.deepEqual(runCalls, [], '空更新绝不能真的调起安装')
  })

  it('过了入口哨兵、等锁期间磁盘被换成目标版 ⇒ 锁后重读仍拒绝，且不启动安装', async () => {
    const { host, runCalls } = makeHost({ installed: '0.3.53', remote: '0.3.54', mutateOnRefetch: true })
    const check = await host.handlers['issue202.updateCheck']({})
    assert.equal(check.ok, true)
    const out = await host.handlers['issue202.updateInstall']({
      checkId: check.receipt.checkId,
      requestId: 'req-noop-race-1',
    })
    assert.equal(out.ok, false)
    assert.equal(out.error, 'installation-changed')
    assert.equal(out.diag && out.diag.detail, '目标版本与已装版本相同，无需安装')
    assert.equal('snapshot' in out, false, '空更新不该留下作业')
    assert.deepEqual(runCalls, [], '竞态下也不能真的调起安装')
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

  it('候选（合规版）路径：等锁期间磁盘被换成目标版 ⇒ 锁后哨兵同样拒绝且不启动安装', async () => {
    const { host, runCalls } = makeCandidateHost({ mutateBeforeLockRead: true })
    const fallback = await askCandidate(host)
    assert.equal(fallback.ok, true)
    assert.equal(fallback.snapshot && fallback.snapshot.candidate, CANDIDATE, '必须先拿到候选回执')
    const out = await host.handlers['issue202c.updateInstall']({
      checkId: fallback.receipt.checkId,
      requestId: 'req-cand-race-1',
      version: CANDIDATE,
    })
    assert.equal(out.ok, false)
    assert.equal(out.error, 'installation-changed')
    assert.equal(out.diag && out.diag.detail, '目标版本与已装版本相同，无需安装', '候选路径也必须说清「无需安装」')
    assert.equal('snapshot' in out, false, '空更新不该留下作业')
    assert.deepEqual(runCalls, [], '竞态下也不能真的调起安装')
  })

  it('对照：候选路径磁盘没被换 ⇒ 正常安装候选版并落到待重启；批准名单也随版本号一起转发', async () => {
    const { host, runCalls, runArgs } = makeCandidateHost()
    const fallback = await askCandidate(host)
    assert.equal(fallback.ok, true)
    const out = await host.handlers['issue202c.updateInstall']({
      checkId: fallback.receipt.checkId,
      requestId: 'req-cand-1',
      version: CANDIDATE,
      approvedBuilds: ['native-a', '--evil'],
    })
    assert.equal(out.ok, true)
    const snapshot = await waitTerminal(host, 'issue202c')
    assert.equal(snapshot.job.state, 'restart-required')
    assert.deepEqual(runCalls, [CANDIDATE])
    // #194 Spec 审查：候选（带 version）分支也要把归一后的批准名单送到安装端口。
    assert.deepEqual(runArgs[0].approvedBuilds, ['native-a'], '候选路径的批准名单要过滤后原样转发')
  })
})
