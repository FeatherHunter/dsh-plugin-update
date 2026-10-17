/**
 * tests/issue-182-unknown-running-version.test.mjs —— 运行版本「未知」是一等状态（#182，S2）。
 *
 * 现象（B 线 R6 / decide.md:16）：集成方拿不到运行版时伪造 `0.0.0` 交进来，本包原样采用，
 * 写进事件 `update.check.done.current` 还参与版本比较——日志里出现一个不存在的运行版，
 * 决策层把一个假版本当真话。修形：端口把「未知」显式化（`null`），检查/决策/事件/面板
 * 统一按未知呈现，不再与版本号比大小，也不再抛 unknown-profile 挡掉整次查询。
 *
 * 只测外部行为：宿主公开电话回包（`dist/host.js`）与面板视图模型（`dist/panel.js`）。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { panelViewModel } from '../dist/panel.js'
import { entryStateKind } from '../dist/entry.js'

const TARGET = 'demo-unknown-running'
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
 * 建宿主：`runningVersion` 缺省 null（= 集成方明确说「运行版未知」，不再伪造 0.0.0）。
 * `installedVersion` 非空时把目标包落盘；`declared` 决定清单里有没有这条依赖。
 */
function makeHost({ installedVersion = null, declared = false, remote = '1.1.0', runningVersion = null } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-182-'))
  tmpRoots.push(profileDir)
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: declared ? { [TARGET]: `^${installedVersion ?? '1.0.0'}` } : {},
  })
  if (installedVersion) makeTargetPackage(join(profileDir, 'node_modules', TARGET), installedVersion)
  const fires = []
  const host = createHostUpdate(
    {
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
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
    { pluginId: 'issue182-plugin', prefix: 'issue182', targetPackageName: TARGET },
  )
  return { host, fires }
}

async function checkSnapshot(host) {
  const out = await host.handlers['issue182.updateCheck']({})
  assert.equal(out.ok, true)
  return out.snapshot
}

function panelOf(snapshot) {
  return panelViewModel({ snapshot, manual: null, queue: null, skippedLatest: false, lastError: null }, 'zh')
}

describe('#182 运行版本未知：如实呈现，不伪造、不比较', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })
  after(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('运行版未知（null）：快照保留「未知」，不宣称有新版，不落伪造版本号', async () => {
    const { host, fires } = makeHost({ installedVersion: '1.0.0', declared: true, remote: '1.1.0', runningVersion: null })
    const snap = await checkSnapshot(host)
    assert.equal(snap.installed, true)
    assert.equal(snap.runningVersion, null, '运行版本未知必须是 null，不是造出来的假版本号')
    assert.equal(snap.latestVersion, '1.1.0')
    assert.equal(snap.canInstall, false, '不知道在跑哪一版就不许宣称「有更新」')
    assert.equal(snap.blockedReason, null, '「未知」不是一种阻拦原因')
    assert.equal(snap.identity, 'update', '磁盘旧版 + 清单在册的换版身份仍可判定（与运行版无关）')

    const done = fires.find((row) => row.event === 'update.check.done')
    assert.ok(done, '检查成功要有 update.check.done')
    assert.equal('current' in done.fields, false, '运行版未知时事件里不许出现 current 格')
    assert.equal(fires.some((row) => JSON.stringify(row.fields ?? {}).includes('0.0.0')), false, '事件里不许落伪造版本号')

    const changed = fires.find((row) => row.event === 'update.status.changed')
    assert.ok(changed, '状态边沿要有 update.status.changed')
    assert.equal(changed.fields.kind, 'unknown', '运行版未知时主状态是 unknown，不是「有新版」')
  })

  it('运行版未知 + 磁盘没有：首次安装照常可装（不靠伪造版号）', async () => {
    const { host } = makeHost({ installedVersion: null, declared: false, remote: '1.0.0', runningVersion: null })
    const snap = await checkSnapshot(host)
    assert.equal(snap.installed, false)
    assert.equal(snap.runningVersion, null)
    assert.equal(snap.canInstall, true)
    assert.equal(snap.identity, 'first-install')
  })

  it('面板：运行版未知时说「未知」，不冒充「已是最新」也不冒充「有新版」', async () => {
    const { host } = makeHost({ installedVersion: '1.0.0', declared: true, remote: '1.1.0', runningVersion: null })
    const view = panelOf(await checkSnapshot(host))
    assert.equal(view.banner.kind, 'blocked')
    assert.match(view.banner.title, /运行.*未知|未知.*运行/)
    assert.doesNotMatch(view.banner.title, /已是最新/)
    assert.doesNotMatch(view.banner.title, /有新版本/)
    assert.equal(view.installEnabled, false)
  })

  it('入口件跟着服务端主状态走：首次安装显示「有更新」，磁盘在场但未知显示「待查」而不是假更新', async () => {
    const absent = await checkSnapshot(makeHost({ installedVersion: null, declared: false, remote: '1.0.0' }).host)
    assert.equal(entryStateKind({ snapshot: absent, error: null }), 'update', '首次安装：服务端说 update-available，入口件不许藏')

    const unknown = await checkSnapshot(makeHost({ installedVersion: '1.0.0', declared: true, remote: '1.1.0' }).host)
    assert.equal(entryStateKind({ snapshot: unknown, error: null }), 'idle', '运行版未知：不宣称有新版（不是假更新）')
  })

  it('运行版未知时不给手工命令（无法验证不会降级，不猜）', async () => {
    const { host } = makeHost({ installedVersion: '1.0.0', declared: true, remote: '1.1.0', runningVersion: null })
    const out = await host.handlers['issue182.updateCheck']({})
    assert.equal(out.ok, true)
    assert.equal(out.manual, null, '未知运行版 → 手工命令回空，不冒充安全建议')
  })
})
