/**
 * tests/issue-241-recovery-deadlock.test.mjs —— #241 恢复死锁：
 * 运行版未加载（集成方注入占位 `0.0.0`）≠ 盘上版时，安装/重试被同一拦截拒绝，只能重启宿主。
 *
 * 真机现场（2026-10-20 web profile）：饼干记账被降到 0.3.79 后又一次中断安装，任务落成
 * `interrupted / installation-changed`；集成方 dsh-life-pack 拿不到宿主半区版本时注入占位
 * 运行版 `0.0.0`。核心把 0.0.0 当成真版本比较：`0.0.0 !== 0.3.79` ⇒
 * `blockedReason='recovery-required'`，而安装闸门又用同一个 blockedReason 把重试全部拒绝，
 * 行内「重试」只留下一句「仍在恢复中」，用户只能重启宿主。
 *
 * 契约（只测外部行为，经公开电话与真实临时目录）：
 * 1. 占位运行版 `0.0.0` 一律按「未知」处理：快照 `runningVersion === null`，
 *    不因占位版与盘上版不同而派生 `recovery-required`；
 * 2. 任务已中断 + 运行版未知 + 盘上是旧版：允许用一次重试完成恢复性安装（不必先重启宿主），
 *    装完照旧 `restart-required`（运行版未知不谎称 completed）；
 * 3. 恢复豁免不放宽已知运行版的现场：真运行版 ≠ 盘上版时 `recovery-required` 照旧
 *    （#179/#215 不回归）；运行版未知且没有中断任务时也不宣称「有更新」（#182 不回归）。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { pathsForUpdate } from '../dist/core/disk.js'

const TARGET = 'demo-241-plugin'
const REGISTRY = 'https://registry.npmjs.org/'
const OLD_VERSION = '1.0.0'
const NEW_VERSION = '2.0.0'
const NOW = 1_000_000
const PREFIX = 'i241'
const PLUGIN_ID = 'issue-241-plugin'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='

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

function makeScope() {
  const home = makeTmp('dpu-241-home-')
  const profile = join(home, 'profiles', 'desktop')
  writeJson(join(profile, 'package.json'), {
    name: 'fake-profile',
    private: true,
    dependencies: { [TARGET]: '^' + OLD_VERSION },
  })
  return { home, profile }
}

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

function registerTarget(profile, version) {
  writeJson(join(profile, 'package.json'), {
    name: 'fake-profile',
    private: true,
    dependencies: { [TARGET]: '^' + version },
  })
}

function seedInterruptedJob(home, profile) {
  const paths = pathsForUpdate(home, PLUGIN_ID, profile)
  assert.ok(paths, '使用范围路径应可派生')
  writeJson(paths.state, {
    id: 'interrupted-job-241',
    state: 'interrupted',
    targetVersion: NEW_VERSION,
    message: 'installation-changed',
    requestId: 'req-241-recover',
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

function makeHost({ home, profile, runningVersion = OLD_VERSION, runInstall = async () => {} }) {
  let random = 0
  const fires = []
  const host = createHostUpdate(
    {
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
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
  return { host, fires }
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
  assert.ok(

    wanted.includes(snapshot.job?.state),
    `任务应停在 ${wanted.join('/')}，实际 ${snapshot.job?.state}（${JSON.stringify(snapshot.job)}，blocked=${snapshot.blockedReason}）`,
  )
  return snapshot
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('#241 占位运行版 0.0.0：不派生 recovery-required、不挡恢复性重试', () => {
  it('中断任务 + 运行版占位 0.0.0 + 盘上旧版：快照不报 recovery-required，检查可装，重试能完成恢复', async () => {
    const { home, profile } = makeScope()
    plantTarget(profile, OLD_VERSION)
    seedInterruptedJob(home, profile)
    __resetSharedUpdateReaderForTests()
    const { host } = makeHost({ home, profile, runningVersion: '0.0.0' })

    const snap = await status(host)
    assert.equal(snap.installed, true, '盘上目标在场')
    assert.equal(snap.installedVersion, OLD_VERSION)
    assert.equal(snap.runningVersion, null, '占位运行版必须按未知呈现，不许进快照')
    assert.equal(snap.blockedReason, null, '占位版不许伪造「安装现场被弄脏」')
    assert.equal(snap.job?.state, 'interrupted', '旧中断任务仍在（不掩盖历史）')

    const checked = await check(host)
    assert.equal(checked.snapshot.canInstall, true, '中断任务 + 运行版未知 + 盘上旧版：重试必须可受理（恢复豁免）')
    assert.equal(checked.snapshot.identity, 'update', '盘上旧版 + 有新版 = 换版身份')
    assert.equal(checked.snapshot.blockedReason, null)

    let materialized = false
    __resetSharedUpdateReaderForTests()
    const { host: installHost } = makeHost({
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
    assert.equal(rechecked.snapshot.canInstall, true, '重试路径：检查后仍可装')
    const installed = await installHost.handlers[`${PREFIX}.updateInstall`]({
      checkId: rechecked.receipt.checkId,
      requestId: 'req-241-retry',
    })
    assert.equal(installed.ok, true, `重试安装应受理：${JSON.stringify(installed)}`)
    const done = await waitForState(installHost, ['restart-required', 'completed'])
    assert.equal(materialized, true, '目标版必须真落盘')
    assert.equal(done.installedVersion, NEW_VERSION)
    assert.equal(done.job?.state, 'restart-required', '运行版未知只能算待重启，不谎称已完成')
  })

  it('占位运行版不进事件（不落伪造版本号）', async () => {
    const { home, profile } = makeScope()
    plantTarget(profile, OLD_VERSION)
    seedInterruptedJob(home, profile)
    __resetSharedUpdateReaderForTests()
    const { host, fires } = makeHost({ home, profile, runningVersion: '0.0.0' })
    await check(host)
    assert.equal(
      fires.some((row) => JSON.stringify(row.fields ?? {}).includes('0.0.0')),
      false,
      '事件里不许落伪造运行版 0.0.0',
    )
  })
})

describe('#241 恢复豁免不越界（回归）', () => {
  it('运行版未知但无中断任务：仍不宣称有更新（#182 不回归）', async () => {
    const { home, profile } = makeScope()
    plantTarget(profile, OLD_VERSION)
    __resetSharedUpdateReaderForTests()
    const { host } = makeHost({ home, profile, runningVersion: null })
    const checked = await check(host)
    assert.equal(checked.snapshot.runningVersion, null)
    assert.equal(checked.snapshot.canInstall, false, '不知道在跑哪一版就不许宣称有更新')
    assert.equal(checked.snapshot.blockedReason, null, '「未知」不是一种阻拦原因')
  })

  it('真运行版 ≠ 盘上版：recovery-required 照旧（#179/#215 不回归）', async () => {
    const { home, profile } = makeScope()
    plantTarget(profile, NEW_VERSION)
    seedInterruptedJob(home, profile)
    __resetSharedUpdateReaderForTests()
    const { host } = makeHost({ home, profile, runningVersion: OLD_VERSION })
    const snap = await status(host)
    assert.equal(snap.blockedReason, 'recovery-required', '已知运行版与盘上版不同，仍须报 recovery-required')
    assert.equal(snap.canInstall, false)
  })
})

