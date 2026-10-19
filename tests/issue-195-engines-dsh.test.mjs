/**
 * tests/issue-195-engines-dsh.test.mjs —— 新版本声明的 DSH 运行时要求看得懂（#195，并入 #182）。
 *
 * 现象（B 线 R4）：远端包 metadata 声明 `engines.dsh` 时本包只读 `engines.node`，检查层
 * 认为可装；点装后宿主按 incompatible-version 拒绝，用户只见裸码。修形：
 * 1. 取数层读 `engines.dsh`（缺省 `*`），检查层在拿得到当前 DSH 版本时提前点明不兼容
 *    （`blockedReason: 'incompatible-dsh'`，拿不到就不猜、不误拦）；
 * 2. 宿主拒绝时把 `error.incompatible[]`（keys 是 `engines.dsh` 或 DSH peer 包名）翻成
 *    「要求 ≥X（当前 Y）」的人话，拼在宿主原话之后（原文在前、建议在后，仍守 300 字）。
 *
 * 只测外部行为：宿主公开电话回包 + 安装执行器的失败详情。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { createUpdateExecutor } from '../dist/core/executor.js'
import { panelViewModel } from '../dist/panel.js'

const TARGET = 'demo-engine-dsh'
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

function fakeLatest(version, dshRange) {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(TARGET)}/latest`)
    const engines = { node: '>=22' }
    if (typeof dshRange === 'string') engines.dsh = dshRange
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: TARGET,
          version,
          engines,
          dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`, integrity: INTEGRITY },
        }),
    }
  }
}

/** 建宿主：`dshVersion` 缺省省略（集成方没给当前 DSH 版本 → 本包不许猜）。 */
function makeHost({ installedVersion = '1.0.0', declared = true, remote = '1.1.0', dshRange, dshVersion, runningVersion = installedVersion } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-195-'))
  tmpRoots.push(profileDir)
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: declared ? { [TARGET]: `^${installedVersion}` } : {},
  })
  if (installedVersion) makeTargetPackage(join(profileDir, 'node_modules', TARGET), installedVersion)
  const readerOverrides = {
    runningVersion,
    targetPackageDir: join(profileDir, 'node_modules', TARGET),
    profileDir,
    profileName: 'desktop',
    homeDir: profileDir,
    fetchImpl: fakeLatest(remote, dshRange),
    now: () => 1_000_000,
    randomId: () => 'id-1',
    nodeVersion: '22.0.0',
    environmentKind: 'cli',
    targetPackageName: TARGET,
    runInstall: async () => {},
    ...memoryStore(),
  }
  if (dshVersion !== undefined) readerOverrides.dshVersion = dshVersion
  const host = createHostUpdate(
    { logCtx: { fire: () => {} }, readerOverrides },
    { pluginId: 'issue195-plugin', prefix: 'issue195', targetPackageName: TARGET },
  )
  return { host }
}

async function checkSnapshot(host) {
  const out = await host.handlers['issue195.updateCheck']({})
  assert.equal(out.ok, true)
  return out.snapshot
}

function panelOf(snapshot) {
  return panelViewModel({ snapshot, manual: null, queue: null, skippedLatest: false, lastError: null }, 'zh')
}

describe('#195 engines.dsh：检查层提前点明不兼容', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })
  after(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('当前 DSH 版本满足声明：照常可装', async () => {
    const { host } = makeHost({ dshRange: '>=1.0.0', dshVersion: '1.5.0' })
    const snap = await checkSnapshot(host)
    assert.equal(snap.blockedReason, null)
    assert.equal(snap.canInstall, true)
  })

  it('当前 DSH 版本不满足声明：blockedReason=incompatible-dsh，不宣称可装', async () => {
    const { host } = makeHost({ dshRange: '>=2.0.0', dshVersion: '1.5.0' })
    const snap = await checkSnapshot(host)
    assert.equal(snap.blockedReason, 'incompatible-dsh')
    assert.equal(snap.canInstall, false)
  })

  it('预发布 DSH 版本按发行版语义比较（0.2.0-rc.2 不满足 >=0.2.1-rc.1，但满足 >=0.2.0-rc.2）', async () => {
    const unmet = await checkSnapshot(makeHost({ dshRange: '>=0.2.1-rc.1', dshVersion: '0.2.0-rc.2' }).host)
    assert.equal(unmet.blockedReason, 'incompatible-dsh')
    const met = await checkSnapshot(makeHost({ dshRange: '>=0.2.0-rc.2', dshVersion: '0.2.0-rc.2' }).host)
    assert.equal(met.blockedReason, null)
  })

  it('0.x 的 caret 按 npm 语义收上界（^0.2.0 不认可 0.3.x；^0.0.3 不认可 0.0.4）', async () => {
    const outOfCaret = await checkSnapshot(makeHost({ dshRange: '^0.2.0', dshVersion: '0.3.0' }).host)
    assert.equal(outOfCaret.blockedReason, 'incompatible-dsh', '^0.2.0 的上界是 <0.3.0，不许放行 0.3.0')
    const insideCaret = await checkSnapshot(makeHost({ dshRange: '^0.2.0', dshVersion: '0.2.5' }).host)
    assert.equal(insideCaret.blockedReason, null)
    const tinyCaret = await checkSnapshot(makeHost({ dshRange: '^0.0.3', dshVersion: '0.0.4' }).host)
    assert.equal(tinyCaret.blockedReason, 'incompatible-dsh')
  })

  it('拿不到当前 DSH 版本：不猜、不误拦（仍可装）', async () => {
    const { host } = makeHost({ dshRange: '>=2.0.0' })
    const snap = await checkSnapshot(host)
    assert.equal(snap.blockedReason, null)
    assert.equal(snap.canInstall, true)
  })

  it('面板按 incompatible-dsh 给点明宿主要求的文案', async () => {
    const { host } = makeHost({ dshRange: '>=2.0.0', dshVersion: '1.5.0' })
    const view = panelOf(await checkSnapshot(host))
    assert.equal(view.banner.kind, 'blocked')
    assert.match(view.banner.title, /宿主/)
    assert.equal(view.installEnabled, false)
  })
})

describe('#195 宿主拒绝 incompatible[]：翻成「要求 ≥X（当前 Y）」人话', () => {
  const PROFILE_DIR = 'C:\\fake\\profiles\\desktop'

  function runWith(parts) {
    return createUpdateExecutor({ environmentKind: 'desktop-manager', profileName: 'desktop', pluginId: 'my-plugin', ...parts })
  }

  async function failureDetail(result) {
    const runInstall = runWith({
      pluginManager: { installBundle: () => Promise.resolve(result) },
      log: () => {},
    })
    try {
      await runInstall({ version: '1.2.3', profileName: 'desktop', environmentKind: 'desktop-manager' })
    } catch (error) {
      assert.equal(error.code, 'install-failed')
      return error.detail ?? ''
    }
    assert.fail('管理器报失败时执行器必须 reject')
  }

  it('incompatible[]（engines.dsh 键）→ 详情补一句要求与当前版本，原文仍在前', async () => {
    const detail = await failureDetail({
      application: 'failed',
      error: {
        code: 'incompatible-version',
        incompatible: [
          {
            name: 'dsh-life-pack',
            version: '2.0.0',
            runtimeVersion: '0.2.0-rc.2',
            requirements: { 'engines.dsh': '>=0.3.0' },
          },
        ],
      },
    })
    assert.match(detail, /incompatible-version/, '宿主原话在前')
    assert.match(detail, />=0\.3\.0/, '点明要求的范围')
    assert.match(detail, /0\.2\.0-rc\.2/, '点明当前 DSH 版本')
    assert.match(detail, /DSH|dsh-life-pack/, '点明是谁的要求')
    assert.ok(detail.length <= 300, `详情仍守 300 字：${detail.length}`)
    assert.ok(detail.startsWith('incompatible-version'), '原文永远在前')
  })

  it('incompatible[]（peer 包名键）也翻得出来', async () => {
    const detail = await failureDetail({
      application: 'failed',
      error: {
        code: 'incompatible-version',
        incompatible: [
          {
            name: 'dsh-prompt',
            version: '3.1.0',
            runtimeVersion: '0.2.0-rc.2',
            requirements: { 'dsh-prompt': '>=1.2.0' },
          },
        ],
      },
    })
    assert.match(detail, /dsh-prompt/)
    assert.match(detail, />=1\.2\.0/)
    assert.match(detail, /0\.2\.0-rc\.2/)
  })

  it('没有 incompatible[] 时保持旧详情形状（不加编造的要求）', async () => {
    const detail = await failureDetail({ application: 'failed', error: { code: 'incompatible-version' } })
    assert.match(detail, /incompatible-version/)
    assert.doesNotMatch(detail, /要求/)
  })
})
