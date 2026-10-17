import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { pathsForUpdate } from '../dist/store.js'

// #203：状态落盘按插件标识分目录，但旧影子回退读的是**冻结字面**
// `updates/dsh-mattpocock-skills-deck/<指纹>`——在新版里那恰好是默认标识自己的实时目录。
// 于是「自己目录里还没有 state.json」的插件会读到默认标识正在跑的任务，heal 之后又把这份
// 别家任务写回自己目录（真机 2026-10-18 01:25 的 deck 任务出现在 life-pack/prompt/calorie）。
// 本文件用同一家目录、同一使用范围、两个插件实例（真实磁盘端口，不注入内存假件）守住：
// 每个插件只读自己目录里的任务，盘上同一 requestId 只落一个标识目录。

const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='
const DEFAULT_PLUGIN = 'dsh-mattpocock-skills-deck'
const OTHER_PLUGIN = 'life-life-pack'
const DEFAULT_TARGET = 'demo-default-identity-plugin'
const OTHER_TARGET = 'demo-other-identity-plugin'
const SHARED_REQUEST = 'rmvco30gx8wcv9'
const OTHER_REQUEST = 'rmvco58y12iqcr'

const tmpRoots = []
after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dpu-203-'))
  tmpRoots.push(home)
  return home
}

function makeProfile(home, deps) {
  const profileDir = join(home, 'profile')
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: deps,
  })
  return profileDir
}

function makeTargetPackage(profileDir, name, version) {
  const dir = join(profileDir, 'node_modules', name)
  writeJson(join(dir, 'package.json'), {
    name,
    version,
    main: './index.js',
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './patch.js' } },
  })
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(join(dir, 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(dir, 'patch.js'), 'module.exports = {}\n')
}

function answer(body) {
  return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) }
}

function latestDoc(name, version) {
  return {
    name,
    version,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${name}/-/${name}-${version}.tgz`, integrity: INTEGRITY },
  }
}

/**
 * 建一个真盘落盘的宿主实例：只覆盖「包定位 / 远端回包 / 安装动作」，
 * 不注入 readJob/writeJob/lock 任何假件——状态目录走真实派生。
 */
function makeHost({ homeDir, profileDir, pluginId, prefix, target, runningVersion, installedVersion, remoteVersion }) {
  const host = createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion,
        targetPackageDir: join(profileDir, 'node_modules', target),
        profileDir,
        profileName: 'desktop',
        homeDir,
        fetchImpl: async (url) => {
          assert.equal(url, `${REGISTRY}${encodeURIComponent(target)}/latest`)
          return answer(latestDoc(target, remoteVersion))
        },
        now: () => 1_000_000,
        randomId: () => `job-${prefix}`,
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: target,
        runInstall: async ({ version }) => {
          makeTargetPackage(profileDir, target, version)
        },
      },
    },
    { pluginId, prefix, targetPackageName: target },
  )
  makeTargetPackage(profileDir, target, installedVersion)
  return host
}

async function waitTerminal(host, prefix) {
  for (let i = 0; i < 100; i += 1) {
    const reply = await host.handlers[`${prefix}.updateStatus`]({})
    const job = reply && reply.snapshot ? reply.snapshot.job : null
    if (job && (job.state === 'restart-required' || job.state === 'completed' || job.state === 'failed')) return job
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('作业没有在 2 秒内落到终态')
}

/** 盘上所有 state.json 里 requestId 命中的那一份（用来数「同一个 requestId 落了几家目录」）。 */
function stateFilesWithRequestId(homeDir, requestId) {
  const updates = join(homeDir, 'updates')
  if (!existsSync(updates)) return []
  return readdirSync(updates, { recursive: true })
    .filter((entry) => String(entry).endsWith('state.json'))
    .map((entry) => join(updates, String(entry)))
    .filter((file) => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')).requestId === requestId
      } catch {
        return false
      }
    })
}

describe('#203 状态落盘按插件标识隔离', () => {
  it('默认标识跑完的任务，不会被别的插件实例读成自己的任务', async () => {
    const homeDir = makeHome()
    const profileDir = makeProfile(homeDir, { [DEFAULT_TARGET]: '^1.0.0', [OTHER_TARGET]: '^3.0.0' })

    __resetSharedUpdateReaderForTests()
    const hostA = makeHost({
      homeDir,
      profileDir,
      pluginId: DEFAULT_PLUGIN,
      prefix: 'a',
      target: DEFAULT_TARGET,
      runningVersion: '1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: '1.1.0',
    })
    const checkA = await hostA.handlers['a.updateCheck']({})
    assert.ok(checkA.receipt && typeof checkA.receipt.checkId === 'string', '查新版必须带回执')
    await hostA.handlers['a.updateInstall']({ checkId: checkA.receipt.checkId, requestId: SHARED_REQUEST })
    assert.equal((await waitTerminal(hostA, 'a')).state, 'restart-required')

    const defaultPaths = pathsForUpdate(homeDir, DEFAULT_PLUGIN, profileDir)
    assert.ok(existsSync(defaultPaths.state), '默认标识的任务应落在自己目录')
    const defaultStateBefore = readFileSync(defaultPaths.state, 'utf8')

    // 另一个插件实例（同一家目录/同一使用范围）还没装过任何东西时读状态：
    // 修复前：旧影子回退读到的是默认标识的实时任务，heal 后又写进自己目录（跨插件污染）。
    __resetSharedUpdateReaderForTests()
    const hostB = makeHost({
      homeDir,
      profileDir,
      pluginId: OTHER_PLUGIN,
      prefix: 'b',
      target: OTHER_TARGET,
      runningVersion: '3.0.0',
      installedVersion: '3.0.0',
      remoteVersion: '3.1.0',
    })
    const statusB = await hostB.handlers['b.updateStatus']({})
    assert.equal(statusB.snapshot.job, null, '别的插件的任务不能被当成本插件的任务')

    const otherPaths = pathsForUpdate(homeDir, OTHER_PLUGIN, profileDir)
    assert.equal(existsSync(otherPaths.state), false, '只读一次状态不能凭空写出别家任务的文件')
    assert.equal(readFileSync(defaultPaths.state, 'utf8'), defaultStateBefore, '默认标识自己的状态文件不能被别的实例改写')
  })

  it('两个插件各自更新时，同一个 requestId 只落一个标识目录', async () => {
    const homeDir = makeHome()
    const profileDir = makeProfile(homeDir, { [DEFAULT_TARGET]: '^1.0.0', [OTHER_TARGET]: '^3.0.0' })

    __resetSharedUpdateReaderForTests()
    const hostA = makeHost({
      homeDir,
      profileDir,
      pluginId: DEFAULT_PLUGIN,
      prefix: 'a',
      target: DEFAULT_TARGET,
      runningVersion: '1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: '1.1.0',
    })
    const checkA = await hostA.handlers['a.updateCheck']({})
    await hostA.handlers['a.updateInstall']({ checkId: checkA.receipt.checkId, requestId: SHARED_REQUEST })
    await waitTerminal(hostA, 'a')

    __resetSharedUpdateReaderForTests()
    const hostB = makeHost({
      homeDir,
      profileDir,
      pluginId: OTHER_PLUGIN,
      prefix: 'b',
      target: OTHER_TARGET,
      runningVersion: '3.0.0',
      installedVersion: '3.0.0',
      remoteVersion: '3.1.0',
    })
    // B 先反复轮询（真机里面板每秒一次），再走自己的更新。
    for (let i = 0; i < 3; i += 1) await hostB.handlers['b.updateStatus']({})
    const checkB = await hostB.handlers['b.updateCheck']({})
    await hostB.handlers['b.updateInstall']({ checkId: checkB.receipt.checkId, requestId: OTHER_REQUEST })
    assert.equal((await waitTerminal(hostB, 'b')).state, 'restart-required')

    assert.equal(stateFilesWithRequestId(homeDir, SHARED_REQUEST).length, 1, '共享 requestId 只能出现在一个标识目录')
    assert.equal(stateFilesWithRequestId(homeDir, OTHER_REQUEST).length, 1)

    const defaultPaths = pathsForUpdate(homeDir, DEFAULT_PLUGIN, profileDir)
    const otherPaths = pathsForUpdate(homeDir, OTHER_PLUGIN, profileDir)
    const defaultJob = JSON.parse(readFileSync(defaultPaths.state, 'utf8'))
    const otherJob = JSON.parse(readFileSync(otherPaths.state, 'utf8'))
    assert.equal(defaultJob.targetVersion, '1.1.0')
    assert.equal(otherJob.targetVersion, '3.1.0')
    assert.equal(defaultJob.requestId, SHARED_REQUEST)
    assert.equal(otherJob.requestId, OTHER_REQUEST)
  })

  it('默认标识重启后仍能从自己目录读回自己的任务', async () => {
    const homeDir = makeHome()
    const profileDir = makeProfile(homeDir, { [DEFAULT_TARGET]: '^1.0.0' })

    __resetSharedUpdateReaderForTests()
    const hostA = makeHost({
      homeDir,
      profileDir,
      pluginId: DEFAULT_PLUGIN,
      prefix: 'a',
      target: DEFAULT_TARGET,
      runningVersion: '1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: '1.1.0',
    })
    const checkA = await hostA.handlers['a.updateCheck']({})
    await hostA.handlers['a.updateInstall']({ checkId: checkA.receipt.checkId, requestId: SHARED_REQUEST })
    await waitTerminal(hostA, 'a')

    // 「重启后」：新实例、同一标识、同一目录；磁盘已换版、运行版仍是旧号。
    __resetSharedUpdateReaderForTests()
    const hostRestarted = makeHost({
      homeDir,
      profileDir,
      pluginId: DEFAULT_PLUGIN,
      prefix: 'a',
      target: DEFAULT_TARGET,
      runningVersion: '1.0.0',
      installedVersion: '1.1.0',
      remoteVersion: '1.1.0',
    })
    const reply = await hostRestarted.handlers['a.updateStatus']({})
    assert.ok(reply.snapshot.job, '重启后应读回自己目录里的任务')
    assert.equal(reply.snapshot.job.targetVersion, '1.1.0')
    assert.equal(reply.snapshot.job.requestId, SHARED_REQUEST)
    assert.notEqual(reply.snapshot.job.state, 'interrupted')
  })
})
