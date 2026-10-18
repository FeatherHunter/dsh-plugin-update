/**
 * tests/issue-215-absent-stale-job.test.mjs —— #215 缺席目标不许被旧失败任务判 recovery-required。
 *
 * 真机现场（2026-10-19 desktop）：过去一批安装失败留下的 `state.json` 还是 `state:"failed"`，
 * 目标包后来被卸掉（磁盘/清单都没有），集成方 dsh-life-pack 又给缺席目标注入占位运行版 `0.0.0`。
 * 老逻辑 `if (job failed/interrupted) { if (runningVersion !== null && installedVersion !== runningVersion)
 * blockedReason = 'recovery-required' }` 于是把「未安装」误判成「安装现场被弄脏」：
 * 批量「全部更新」报 recovery-required，复制诊断还带 `运行版：0.0.0`。
 *
 * 契约（只测外部行为，经公开电话与真实临时目录）：
 * 1. 缺席 + 旧失败任务 + 注入假运行版：`installed === false`、`blockedReason === null`、
 *    `runningVersion === null`（未安装没有「正在跑哪版」），仍可按「首次安装」从零装好；
 * 2. 诊断文本绝不为缺席目标显示伪造运行版 `0.0.0`（#134 面板口径延伸到批量复制）；
 * 3. 在场 + 旧失败任务 + 磁盘版≠运行版：recovery-required 照旧（#179 不回归）。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { batchFailedDiagText } from '../dist/panel-batch.js'
import { pathsForUpdate } from '../dist/store.js'

const TARGET = 'demo-215-plugin'
const REGISTRY = 'https://registry.npmjs.org/'
const OLD_VERSION = '1.0.0'
const NEW_VERSION = '2.0.0'
const NOW = 1_000_000
const PREFIX = 'i215'
const PLUGIN_ID = 'issue-215-plugin'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='
/** 真机上旧任务留下的原话（host-install-exits 的 bundle-in-use 人话）。 */
const STALE_FAILURE = 'bundle-in-use；还有别的层在用这个插件，请先在宿主插件页停用后再更新'

const tmpRoots = []

function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}

/** 真临时使用范围：家目录 + profiles/desktop（清单声明依赖，目标包按需落/删）。 */
function makeScope() {
  const home = makeTmp('dpu-215-home-')
  const profile = join(home, 'profiles', 'desktop')
  writeJson(join(profile, 'package.json'), {
    name: 'fake-profile',
    private: true,
    dependencies: { [TARGET]: '^' + OLD_VERSION },
  })
  return { home, profile }
}

/** 在场包（含入口三件，读取器认的那三个），用于造在场/换版现场。 */
function plantTarget(profile, version) {
  const dir = join(profile, 'node_modules', TARGET)
  writeJson(join(dir, 'package.json'), {
    name: TARGET,
    version,
    main: 'index.js',
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './patch.js' } },
  })
  for (const file of ['index.js', 'client.js', 'patch.js']) writeFileSync(join(dir, file), 'module.exports = {}\n')
  return dir
}

/** 模拟真机：目标包被卸掉，清单里也没有它了（缺席 + 未登记）。 */
function removeTarget(profile) {
  rmSync(join(profile, 'node_modules', TARGET), { recursive: true, force: true })
  writeJson(join(profile, 'package.json'), { name: 'fake-profile', private: true, dependencies: {} })
}

/** 装好后真机执行器会做的一半：把目标包登记回清单（读取器据此判 registered）。 */
function registerTarget(profile, version) {
  writeJson(join(profile, 'package.json'), {
    name: 'fake-profile',
    private: true,
    dependencies: { [TARGET]: '^' + version },
  })
}

function releaseDoc(version) {
  return {
    ok: true,
    status: 200,
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

/** 只覆盖取数与执行；任务/锁/读盘一律走真实临时目录。 */
function makeHost({ home, profile, runningVersion = OLD_VERSION, runInstall = async () => {} }) {
  let random = 0
  return createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion,
        targetPackageDir: join(profile, 'node_modules', TARGET),
        profileDir: profile,
        profileName: 'desktop',
        homeDir: home,
        fetchImpl: async () => releaseDoc(NEW_VERSION),
        now: () => NOW,
        randomId: () => `id-${(random += 1)}`,
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        runInstall,
      },
    },
    { pluginId: PLUGIN_ID, prefix: PREFIX, targetPackageName: TARGET },
  )
}

async function status(host) {
  const out = await host.handlers[`${PREFIX}.updateStatus`]({})
  assert.equal(out.ok, true, `状态电话应成功：${JSON.stringify(out)}`)
  return out.snapshot
}

async function check(host) {
  const out = await host.handlers[`${PREFIX}.updateCheck`]({})
  assert.equal(out.ok, true, `检查电话应成功：${JSON.stringify(out)}`)
  return out
}

async function waitForState(host, wanted, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let snapshot = await status(host)
  while (Date.now() < deadline && !wanted.includes(snapshot.job?.state)) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    snapshot = await status(host)
  }
  assert.ok(wanted.includes(snapshot.job?.state), `任务应停在 ${wanted.join('/')}，实际 ${snapshot.job?.state}（${JSON.stringify(snapshot.job)}，blocked=${snapshot.blockedReason}）`)
  return snapshot
}

/**
 * 直接按真机昨天的形状落一条旧失败任务（state.json）。
 * 不跑真安装：真安装失败会在队列里留一次性的 waiting 占位（要等 TTL 才清），
 * 那是测试时钟恒定的夹具副作用，会把后续首次安装挤成 update-busy——与本票无关。
 */
function seedStaleFailedJob(home, profile) {
  const paths = pathsForUpdate(home, PLUGIN_ID, profile)
  assert.ok(paths, '使用范围路径应可派生')
  writeJson(paths.state, {
    id: 'stale-job-1',
    state: 'failed',
    targetVersion: NEW_VERSION,
    message: `install-failed: ${STALE_FAILURE}`,
    requestId: 'batch-stale-1',
  })
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #215：缺席目标 + 旧失败任务不再判 recovery-required', () => {
  it('缺席（旧任务还在、集成注入 0.0.0）：不阻塞、不伪造运行版，查完能按首次安装从零装好', async () => {
    const { home, profile } = makeScope()
    seedStaleFailedJob(home, profile)
    // 真机序列：这批失败之后两个包被卸掉（磁盘与清单都不在）。
    removeTarget(profile)

    __resetSharedUpdateReaderForTests()
    // 集成方 dsh-life-pack 对缺席目标注入的占位运行版（MISSING_RUNNING_VERSION）。
    const host = makeHost({ home, profile, runningVersion: '0.0.0' })

    const snap = await status(host)
    assert.equal(snap.installed, false, '目标确实不在场')
    assert.equal(snap.installedVersion, null)
    assert.equal(snap.job?.state, 'failed', '旧任务仍在（不掩盖历史）')
    assert.equal(snap.job?.message, `install-failed: ${STALE_FAILURE}`)
    assert.equal(snap.blockedReason, null, '未安装不是任何阻塞原因：旧失败任务不许判 recovery-required')
    assert.equal(snap.runningVersion, null, '未安装没有「正在跑哪版」——注入的 0.0.0 不许进快照')

    const checked = await check(host)
    assert.equal(checked.snapshot.blockedReason, null)
    assert.equal(checked.snapshot.latestVersion, NEW_VERSION)
    assert.equal(checked.snapshot.canInstall, true, '缺席目标应可安装')
    assert.equal(checked.snapshot.identity, 'first-install', '未登记 + 缺席 = 首次安装')
    assert.equal(checked.snapshot.runningVersion, null)
    assert.ok(checked.receipt && typeof checked.receipt.checkId === 'string')

    // 从零装好（旧失败任务被本次安装覆盖）。
    let materialized = false
    // 读取器按「插件 + 覆盖项」共享；换执行口前先重置，别复用上一位读到的空执行器。
    __resetSharedUpdateReaderForTests()
    const installHost = makeHost({
      home,
      profile,
      runningVersion: '0.0.0',
      runInstall: async ({ version }) => {
        plantTarget(profile, version)
        registerTarget(profile, version)
        materialized = true
      },
    })
    const rechecked = await check(installHost)
    const installed = await installHost.handlers[`${PREFIX}.updateInstall`]({
      checkId: rechecked.receipt.checkId,
      requestId: 'batch-215-install',
    })
    assert.equal(installed.ok, true, `安装应受理：${JSON.stringify(installed)}`)
    const done = await waitForState(installHost, ['restart-required', 'completed'])
    assert.equal(materialized, true, '目标版必须真落盘')
    assert.equal(done.installed, true)
    assert.equal(done.installedVersion, NEW_VERSION)
    assert.notEqual(done.job?.state, 'failed', '新任务不许还是旧失败')
  })
})

describe('issue #215：诊断文本不许为缺席目标显示伪造运行版', () => {
  /** 真机复制出来的那一行形状：旧任务 diag + 当帧快照（缺席，却带着注入的 0.0.0）。 */
  function failedRowOf(snapshotOverrides = {}, diagOverrides = {}) {
    return {
      key: 'chef',
      title: 'Chef',
      pluginId: 'life-chef',
      phase: 'failed',
      targetVersion: null,
      restartRequired: false,
      error: 'recovery-required',
      snapshot: {
        runningVersion: '0.0.0',
        installed: false,
        installedVersion: null,
        latestVersion: null,
        canInstall: false,
        blockedReason: 'recovery-required',
        job: {
          state: 'failed',
          targetVersion: NEW_VERSION,
          message: `install-failed: ${STALE_FAILURE}`,
          requestId: 'batch-stale-2',
        },
        ...snapshotOverrides,
      },
      manual: null,
      queue: null,
      profileName: 'desktop',
      hostKind: 'desktop-manager',
      diag: { v: 1, detail: STALE_FAILURE, ...diagOverrides },
    }
  }

  it('缺席行：复制诊断不含 0.0.0，版本格按未安装口径显示未知', () => {
    const text = batchFailedDiagText([failedRowOf()], 'zh')
    assert.ok(text.includes('life-chef'), '诊断要带该行插件标识')
    assert.ok(!text.includes('0.0.0'), '缺席目标不许显示伪造运行版 0.0.0：' + JSON.stringify(text))
    assert.ok(text.includes('运行版：未知'), '运行版一栏应是未知：' + JSON.stringify(text))
  })

  it('在场行不受影响：真运行版照常显示（回归）', () => {
    const row = failedRowOf({
      runningVersion: '1.0.0',
      installed: true,
      installedVersion: '1.0.0',
      blockedReason: 'pending-restart',
    })
    const text = batchFailedDiagText([row], 'zh')
    assert.ok(text.includes('运行版：1.0.0'), '在场时运行版照常显示：' + JSON.stringify(text))
  })
})

describe('issue #215：在场 + 旧失败任务仍判 recovery-required（#179 不回归）', () => {
  it('磁盘版与运行版不同：recovery-required 照旧', async () => {
    const { home, profile } = makeScope()
    // 安装失败前磁盘已换版（模拟「装了一半」）：磁盘上是目标版，旧任务仍是 failed。
    plantTarget(profile, NEW_VERSION)
    seedStaleFailedJob(home, profile)

    __resetSharedUpdateReaderForTests()
    const host = makeHost({ home, profile, runningVersion: OLD_VERSION })
    const snap = await status(host)
    assert.equal(snap.installed, true)
    assert.equal(snap.blockedReason, 'recovery-required', '在场且磁盘版≠运行版，仍须报 recovery-required')
    assert.equal(snap.canInstall, false)
  })
})
