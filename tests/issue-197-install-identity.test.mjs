/**
 * tests/issue-197-install-identity.test.mjs —— 同一颗按钮三种身份可辨别（#197，S2）。
 *
 * 真机与探针双证（审查 A 线 §3、C 线 F3）：同一个「更新」按钮背后有三种完全不同的身份，
 * 用户不可辨别——
 * 1. 磁盘装着、清单在册：正常换版（HMR 宿主走 remove→install，失败如实报）；
 * 2. 磁盘没有、清单也没登记：这其实是**首次安装（新增依赖）**，不是换版，且要重启宿主才加载；
 * 3. 磁盘已是远端最新：应直接说「已是最新」，不要发起一次注定被拒绝/空转的安装。
 *
 * 修形：查新版时由核心按「磁盘在场 + profile 清单登记 + 版本比较」判定身份，随快照的
 * `identity` 字段交给面板（`'update' | 'first-install' | 'up-to-date' | null`），面板按身份
 * 给三种不同文案。判定不了的老/坏形态为 null，绝不冒充「首次安装」。
 *
 * 只测外部行为：公开电话回包 + 面板视图模型（`dist/host.js`、`dist/panel.js`）。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { panelViewModel } from '../dist/panel.js'

const TARGET = 'demo-identity-plugin'
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
          dist: { tarball: `${REGISTRY}${TARGET}/-/demo-identity-plugin-${remoteVersion}.tgz`, integrity: INTEGRITY },
        }),
    }
  }
}

/**
 * 建宿主：`installedVersion` 为磁盘已装版（null=磁盘没有）；`declared` 为清单里是否有这个依赖。
 * 两者组合正好覆盖三种身份与两种「不可冒充」的坏形态。
 */
function makeHost({ installedVersion = null, declared = false, remote, runningVersion = installedVersion ?? '0.0.0' }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-197-'))
  tmpRoots.push(profileDir)
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: declared ? { [TARGET]: `^${installedVersion ?? '1.0.0'}` } : {},
  })
  if (installedVersion) makeTargetPackage(join(profileDir, 'node_modules', TARGET), installedVersion)
  const host = createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion,
        targetPackageDir: join(profileDir, 'node_modules', TARGET),
        profileDir,
        profileName: 'desktop',
        homeDir: profileDir,
        fetchImpl: fakeLatest(remote),
        now: () => 1_000_000,
        randomId: () => 'id-1',
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        runInstall: async () => {},
        ...memoryStore(),
      },
    },
    { pluginId: 'issue-197-plugin', prefix: 'issue197', targetPackageName: TARGET },
  )
  return { host }
}

async function checkSnapshot(host) {
  const out = await host.handlers['issue197.updateCheck']({})
  assert.equal(out.ok, true)
  return out.snapshot
}

function panelOf(snapshot) {
  return panelViewModel({ snapshot, manual: null, queue: null, skippedLatest: false, lastError: null }, 'zh')
}

describe('#197 安装身份：按钮前先辨三种身份', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })
  after(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('磁盘没有、清单也没登记 ⇒ first-install（新增依赖，不是换版）', async () => {
    const { host } = makeHost({ declared: false, remote: '1.0.0' })
    const snap = await checkSnapshot(host)
    assert.equal(snap.installed, false)
    assert.equal(snap.canInstall, true)
    assert.equal(snap.identity, 'first-install')
  })

  it('磁盘装着旧版、清单在册 ⇒ update（换版）', async () => {
    const { host } = makeHost({ installedVersion: '1.0.0', declared: true, remote: '1.1.0' })
    const snap = await checkSnapshot(host)
    assert.equal(snap.installed, true)
    assert.equal(snap.canInstall, true)
    assert.equal(snap.identity, 'update')
  })

  it('磁盘已是远端最新 ⇒ up-to-date（不发起注定空转的安装）', async () => {
    const { host } = makeHost({ installedVersion: '1.1.0', declared: true, remote: '1.1.0' })
    const snap = await checkSnapshot(host)
    assert.equal(snap.canInstall, false)
    assert.equal(snap.latestVersion, '1.1.0')
    assert.equal(snap.identity, 'up-to-date')
  })

  it('磁盘装着但清单未选中（chef/home 旧形态）⇒ update，不冒充首次安装', async () => {
    const { host } = makeHost({ installedVersion: '1.0.0', declared: false, remote: '1.1.0' })
    const snap = await checkSnapshot(host)
    assert.equal(snap.installed, true)
    assert.equal(snap.identity, 'update')
  })

  it('清单登记了但磁盘缺失（坏安装）⇒ 身份未知，不冒充「首次安装（新增依赖）」', async () => {
    const { host } = makeHost({ installedVersion: null, declared: true, remote: '1.0.0', runningVersion: '1.0.0' })
    const snap = await checkSnapshot(host)
    assert.equal(snap.installed, false)
    assert.equal(snap.identity, null)
  })

  it('同一颗按钮三种身份 → 三种不同文案（更新 / 首次安装 / 已是最新）', async () => {
    const update = panelOf(await checkSnapshot(makeHost({ installedVersion: '1.0.0', declared: true, remote: '1.1.0' }).host))
    const first = panelOf(await checkSnapshot(makeHost({ declared: false, remote: '1.0.0' }).host))
    const done = panelOf(await checkSnapshot(makeHost({ installedVersion: '1.1.0', declared: true, remote: '1.1.0' }).host))

    assert.equal(update.banner.kind, 'update')
    assert.match(update.banner.title, /有新版本/)
    assert.match(update.installLabel, /安装版本/)

    assert.equal(first.banner.kind, 'update')
    assert.match(first.banner.title, /首次安装/)
    assert.match(first.banner.title, /新增依赖/)
    assert.match(first.installLabel, /首次安装/)
    assert.equal(first.installEnabled, true)

    assert.equal(done.banner.kind, 'done')
    assert.match(done.banner.title, /已是最新/)
    assert.equal(done.installEnabled, false)

    assert.notEqual(first.banner.title, update.banner.title, '首次安装与换版必须是两张脸')
    assert.notEqual(first.installLabel, update.installLabel, '按钮文字也必须不同')
    assert.notEqual(done.banner.title, update.banner.title)
    assert.notEqual(done.banner.title, first.banner.title)
  })
})
