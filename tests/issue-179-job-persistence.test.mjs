/**
 * tests/issue-179-job-persistence.test.mjs —— #179 任务状态只在内存 + #186 前版本保真。
 *
 * 契约（只测外部行为，经公开电话与真实临时目录，不碰实现细节）：
 * 1. 安装开始后任务状态必须落盘（`<home>/updates/.../state.json`）；进程崩溃/重启后新实例
 *    能读回同一条任务，`installing` 换算成 `interrupted`，环境「磁盘已换版、运行版未换」
 *    时快照必须报 `recovery-required`（不许画成「待重启/正常终态」）。
 * 2. 失败原文跨进程不丢：重启后仍能从状态里读到「失败码: 宿主原话」。
 * 3. 前版本保真（#186）：安装进入终态后 `before.json.previousVersion` 非空；状态读取路径
 *    能读回它——即使 state.json 是老形状（没有 previousVersion 字段），也要从 before.json 补上。
 *
 * 网络、执行全用假件；只有任务/快照/锁的落盘是真的（临时家目录 + 临时使用范围）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const OLD_VERSION = '1.0.0'
const NEW_VERSION = '2.0.0'
const NOW = 1_000_000
const PREFIX = 'p179'
const PLUGIN_ID = 'issue-179-plugin'

const tmpRoots = []

function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

function goodRelease() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        name: TARGET,
        version: NEW_VERSION,
        engines: { node: '>=22' },
        dist: {
          tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${NEW_VERSION}.tgz`,
          integrity: 'sha512-' + 'A'.repeat(86) + '==',
        },
      }),
  }
}

function eligibleEnv({ home, profile, installedVersion }) {
  return {
    profileName: 'desktop',
    environmentKind: 'cli',
    homeDir: home,
    profileDir: profile,
    installedVersion,
    packageValid: true,
    sourceInstall: false,
    blockedReason: null,
    installationKey: 'key-1',
    eligible: true,
  }
}

/** 真落盘：只覆盖取数与执行，不给 readJob/writeJob/锁（它们必须走真实磁盘端口）。 */
function makeHost({ home, profile, installedVersion, runInstall }) {
  let random = 0
  const installed = typeof installedVersion === 'function' ? installedVersion : () => installedVersion
  return createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion: OLD_VERSION,
        profileDir: profile,
        profileName: 'desktop',
        homeDir: home,
        fetchImpl: async () => goodRelease(),
        now: () => NOW,
        randomId: () => `id-${(random += 1)}`,
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        readInstalled: async () => eligibleEnv({ home, profile, installedVersion: installed() }),
        runInstall: runInstall ?? (async () => {}),
      },
    },
    { pluginId: PLUGIN_ID, prefix: PREFIX, targetPackageName: TARGET }
  )
}

/** 在临时家目录里找出所有 state.json / before.json（不猜目录形状，只认文件契约名）。 */
function findFiles(root, filename) {
  let entries = []
  try {
    entries = readdirSync(join(root, 'updates'), { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name === filename)
    .map((entry) => join(entry.parentPath, entry.name))
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function check(host) {
  const out = await host.handlers[`${PREFIX}.updateCheck`]({})
  assert.equal(out.ok, true, `检查应成功：${JSON.stringify(out)}`)
  assert.equal(out.snapshot.latestVersion, NEW_VERSION)
  assert.equal(out.snapshot.canInstall, true)
  return out.receipt.checkId
}

async function status(host) {
  const out = await host.handlers[`${PREFIX}.updateStatus`]({})
  assert.equal(out.ok, true)
  return out.snapshot
}

async function waitForState(host, wanted, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let snapshot = await status(host)
  while (Date.now() < deadline && !wanted.includes(snapshot.job?.state)) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    snapshot = await status(host)
  }
  assert.ok(wanted.includes(snapshot.job?.state), `任务应停在 ${wanted.join('/')}，实际 ${snapshot.job?.state}`)
  return snapshot
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

process.on('exit', () => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #179：任务状态落盘、崩溃后可恢复', () => {
  it('安装中崩溃：新实例读回任务并报 recovery-required，而不是「待重启」', async () => {
    const home = makeTmp('dpu-179-home-')
    const profile = makeTmp('dpu-179-profile-')
    let releaseInstall = null
    const host1 = makeHost({
      home,
      profile,
      installedVersion: OLD_VERSION,
      runInstall: () => new Promise((resolve) => (releaseInstall = resolve)),
    })
    const checkId = await check(host1)
    const started = await host1.handlers[`${PREFIX}.updateInstall`]({ checkId, requestId: 'req-179-1' })
    assert.equal(started.ok, true)
    assert.equal(started.snapshot.job.state, 'installing')

    // 落盘证据：安装一开始就有 state.json，里面是这条任务。
    const stateFiles = findFiles(home, 'state.json')
    assert.equal(stateFiles.length, 1, '安装中必须留下 state.json')
    const persisted = readJsonFile(stateFiles[0])
    assert.equal(persisted.state, 'installing')
    assert.equal(persisted.targetVersion, NEW_VERSION)

    // 崩溃：丢掉进程内一切，磁盘上却已经换好版（安装完成但宿主没重启）。
    __resetSharedUpdateReaderForTests()
    const host2 = makeHost({ home, profile, installedVersion: NEW_VERSION })
    const recovered = await status(host2)
    assert.equal(recovered.job.state, 'interrupted', '挂在安装中的任务重启后必须换算成中断')
    assert.equal(recovered.job.message, 'recovery-required')
    assert.equal(recovered.blockedReason, 'recovery-required', '磁盘换版而运行版未换，必须报 recovery-required')
    assert.equal(recovered.canInstall, false)

    if (releaseInstall) releaseInstall()
  })

  it('失败原文跨进程不丢：重启后仍读到「失败码: 宿主原话」', async () => {
    const home = makeTmp('dpu-179-home-')
    const profile = makeTmp('dpu-179-profile-')
    const host1 = makeHost({
      home,
      profile,
      installedVersion: (() => {
        let version = OLD_VERSION
        return () => version
      })(),
      runInstall: async () => {
        throw Object.assign(new Error('install-failed'), { code: 'install-failed', detail: '宿主原话：权限不足' })
      },
    })
    const checkId = await check(host1)
    await host1.handlers[`${PREFIX}.updateInstall`]({ checkId, requestId: 'req-179-2' })
    const failed = await waitForState(host1, ['failed'])
    assert.match(failed.job.message, /^install-failed: 宿主原话：权限不足$/)

    __resetSharedUpdateReaderForTests()
    const host2 = makeHost({ home, profile, installedVersion: OLD_VERSION })
    const recovered = await status(host2)
    assert.equal(recovered.job.state, 'failed')
    assert.equal(recovered.job.message, 'install-failed: 宿主原话：权限不足', '重启后失败原文必须还在')
  })
})

describe('issue #186：前版本保真（并进 #179 同批）', () => {
  it('终态后 before.json / state.json 都带前版本；老形状 state.json 也能从 before.json 读回', async () => {
    const home = makeTmp('dpu-186-home-')
    const profile = makeTmp('dpu-186-profile-')
    let installedNow = OLD_VERSION
    const host1 = makeHost({
      home,
      profile,
      installedVersion: () => installedNow,
      runInstall: async () => {
        installedNow = NEW_VERSION
      },
    })
    const checkId = await check(host1)
    await host1.handlers[`${PREFIX}.updateInstall`]({ checkId, requestId: 'req-186-1' })
    const done = await waitForState(host1, ['restart-required', 'completed'])
    assert.equal(done.job.state, 'restart-required')

    const beforeFiles = findFiles(home, 'before.json')
    assert.equal(beforeFiles.length, 1, '终态后必须留下 before.json')
    assert.equal(readJsonFile(beforeFiles[0]).previousVersion, OLD_VERSION, 'before.json 必须记住前版本')

    const stateFiles = findFiles(home, 'state.json')
    assert.equal(stateFiles.length, 1)
    const persisted = readJsonFile(stateFiles[0])
    assert.equal(persisted.previousVersion, OLD_VERSION, 'state.json 必须记住前版本')

    // 老形状：把 previousVersion 从 state.json 拿掉，模拟旧版本写下的状态。
    delete persisted.previousVersion
    writeFileSync(stateFiles[0], JSON.stringify(persisted, null, 2) + '\n')

    __resetSharedUpdateReaderForTests()
    const host2 = makeHost({ home, profile, installedVersion: NEW_VERSION })
    const recovered = await status(host2)
    assert.equal(recovered.job.state, 'restart-required')
    assert.equal(recovered.job.previousVersion, OLD_VERSION, '状态读取路径必须能从 before.json 读回前版本')
  })
})
