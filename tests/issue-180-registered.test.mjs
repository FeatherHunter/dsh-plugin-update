/**
 * tests/issue-180-registered.test.mjs —— 装后按「在册」核实（#180，S0）。
 *
 * 只测外部行为（宿主公开电话出口 `dist/host.js` 的回包），不直调内部函数：
 * 用真临时 profile 目录造盘面，`runInstall` 假件按场景改盘（磁盘版本 + 清单登记），网络一律假件。
 *
 * 钉死的契约（#180 修形）：
 * 1. 装完磁盘版本到目标、但 profile 清单 `dsh.profile.bundles` 里没有这个包
 *    ⇒ 必须 `install-failed`，细节写明「profile 未登记该插件（重启后不会加载）」——
 *    磁盘换版不等于重启后会加载，不能对外报成功（probe-b S2 的静默成功形态）。
 * 2. 清单里 `dependencies` 更新了、但 `dsh.profile.bundles` 仍没有 ⇒ 同上（宿主编排只落了一半）。
 * 3. 正常形态：清单更新且 bundles 里有这个包 ⇒ 终态 `restart-required`。
 * 4. 老/最小清单没有 `dsh.profile.bundles` 这一层概念 ⇒ 退回 `dependencies` 键判在册，照旧成功。
 * 5. bundles 层在但读不成数组（`null`）⇒ 按未登记失败，不退回 `dependencies` 把半装态洗成成功。
 * 6. 老/最小清单（无 bundles 层）：装后清单里没有该包 ⇒ 退回 `dependencies` 也判未登记
 *    （证明读的是装后清单，不是装前快照）。
 *
 * 先红后绿：未修树红在 1/2/5/6（会以 `restart-required` 收尾，把「重启后不会加载」当成功）。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-registered-plugin'
const INSTALLED = '0.3.53'
const REMOTE = '0.3.54'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='
/** 装后「未登记」失败的一句完整原文（码 + 细节；形状=codes 前缀 + 冒号 + 人话）。 */
const NOT_REGISTERED = 'install-failed: 装完校验没过：profile 未登记该插件（重启后不会加载）'

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

function readProfile(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

/** 造 profile：deps 里有目标包（^旧版），bundles 可给可不给（不给=老/最小清单）。 */
function makeProfile({ bundles } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-180-'))
  const manifest = {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: `^${INSTALLED}` },
  }
  if (bundles !== undefined) manifest.dsh = { profile: { bundles } }
  writeJson(join(profileDir, 'package.json'), manifest)
  return profileDir
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

/**
 * 建宿主：`runInstall` 按场景改盘。
 *   diskOnly      —— 只把 node_modules 版本换成目标版本（宿主 applied 但清单没登记）
 *   depsOnly      —— 换盘 + 把 dependencies 写成目标精确版本，但不进 bundles（只落了一半）
 *   legacyRemoveDep——换盘 + 把 dependencies 里的目标包删掉（证明老清单也读装后清单）
 *   registered    —— 换盘 + 写 dependencies + 目标包进 bundles（正常形态）
 */
function makeHost(profileDir, { mode } = {}) {
  const runInstall = async ({ version }) => {
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), version)
    if (mode === 'diskOnly') return
    const manifest = readProfile(profileDir)
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [TARGET]: version }
    if (mode === 'legacyRemoveDep') delete manifest.dependencies[TARGET]
    if (mode === 'registered') {
      const profile = manifest.dsh?.profile ?? {}
      const bundles = Array.isArray(profile.bundles) ? profile.bundles : []
      manifest.dsh = { profile: { ...profile, bundles: bundles.includes(TARGET) ? bundles : [...bundles, TARGET] } }
    }
    writeJson(join(profileDir, 'package.json'), manifest)
  }
  return createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion: INSTALLED,
        targetPackageDir: join(profileDir, 'node_modules', TARGET),
        profileDir,
        profileName: 'desktop',
        homeDir: profileDir,
        fetchImpl: fakeLatest(REMOTE),
        now: () => 1_000_000,
        randomId: () => 'id-1',
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        runInstall,
        ...memoryStore(),
      },
    },
    { pluginId: 'issue-180-plugin', prefix: 'issue180', targetPackageName: TARGET },
  )
}

/** 查新版 → 安装 → 轮询到终态。返回终态快照。 */
async function installAndWait(host) {
  const check = await host.handlers['issue180.updateCheck']({})
  assert.equal(check.ok, true)
  assert.ok(check.receipt && typeof check.receipt.checkId === 'string', '查新版必须带回执')
  const installed = await host.handlers['issue180.updateInstall']({
    checkId: check.receipt.checkId,
    requestId: 'req-180-1',
  })
  assert.equal(installed.ok, true)
  const deadline = Date.now() + 15000
  for (;;) {
    const last = await host.handlers['issue180.updateStatus']({})
    assert.equal(last.ok, true)
    const state = last.snapshot.job ? last.snapshot.job.state : null
    if (state === 'restart-required' || state === 'completed' || state === 'failed') return last.snapshot
    if (Date.now() > deadline) throw new Error(`安装 15 秒未收尾，最后状态=${state}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const tmpRoots = []
beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #180：装后按「在册」核实（磁盘换版 ≠ 重启后会加载）', () => {
  it('清单 bundles 里没有该包（宿主 applied 但没登记）⇒ install-failed，细节说清「未登记」', async () => {
    const profileDir = makeProfile({ bundles: [] })
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), INSTALLED)
    const host = makeHost(profileDir, { mode: 'diskOnly' })
    const final = await installAndWait(host)
    assert.equal(final.installedVersion, REMOTE, '磁盘确实换到目标版本了')
    assert.ok(final.job, '必须有终态任务')
    assert.equal(final.job.state, 'failed')
    assert.equal(final.job.message, NOT_REGISTERED)
  })

  it('dependencies 更新了但 bundles 仍没有该包（只落了一半）⇒ 同样 install-failed', async () => {
    const profileDir = makeProfile({ bundles: [] })
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), INSTALLED)
    const host = makeHost(profileDir, { mode: 'depsOnly' })
    const final = await installAndWait(host)
    assert.ok(final.job)
    assert.equal(final.job.state, 'failed')
    assert.equal(final.job.message, NOT_REGISTERED)
  })

  it('bundles 层在但读不成数组（null）⇒ 按未登记失败，不退回 dependencies 洗成成功', async () => {
    const profileDir = makeProfile({ bundles: null })
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), INSTALLED)
    const host = makeHost(profileDir, { mode: 'depsOnly' })
    const final = await installAndWait(host)
    assert.ok(final.job)
    assert.equal(final.job.state, 'failed')
    assert.equal(final.job.message, NOT_REGISTERED)
  })

  it('正常形态：清单登记且 bundles 里在册 ⇒ 终态 restart-required', async () => {
    const profileDir = makeProfile({ bundles: [TARGET] })
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), INSTALLED)
    const host = makeHost(profileDir, { mode: 'registered' })
    const final = await installAndWait(host)
    assert.ok(final.job)
    assert.equal(final.job.state, 'restart-required')
    assert.equal(final.job.message, null)
    assert.equal(final.installedVersion, REMOTE)
  })

  it('老/最小清单没有 dsh.profile.bundles ⇒ 退回 dependencies 判在册，照旧成功', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), INSTALLED)
    const host = makeHost(profileDir, { mode: 'depsOnly' })
    const final = await installAndWait(host)
    assert.ok(final.job)
    assert.equal(final.job.state, 'restart-required')
    assert.equal(final.installedVersion, REMOTE)
  })

  it('老/最小清单：装后清单里没有该包 ⇒ 退回 dependencies 也判未登记（读的是装后清单）', async () => {
    const profileDir = makeProfile()
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), INSTALLED)
    const host = makeHost(profileDir, { mode: 'legacyRemoveDep' })
    const final = await installAndWait(host)
    assert.ok(final.job)
    assert.equal(final.job.state, 'failed')
    assert.equal(final.job.message, NOT_REGISTERED)
  })
})
