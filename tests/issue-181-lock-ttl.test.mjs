/**
 * tests/issue-181-lock-ttl.test.mjs —— #181 安装锁/全局锁双向失灵（陈旧锁被抢 / 坏锁永久 update-busy）。
 *
 * 契约（只经公开电话与真实临时目录，锁的形状与时间由测试亲手造）：
 * 1. 判据只看「时间 + 可解析性」，不再拿 state.json 当证据（#179 之前 state.json 从不落盘，
 *    旧判据退化成「锁能解析就抢」）：
 *    - 可解析且 `startedAt` 早于安装额度 ⇒ 回收；
 *    - 不可解析（空文件/半截 JSON/`null`）且 mtime 早于安装额度 ⇒ 回收；
 *    - 其余（新鲜）⇒ 拒，报 update-busy，锁原样不动。
 * 2. 锁写入是原子的：回收后重建、正常抢锁都不留 `*.tmp`，成功路径放锁后锁文件消失。
 * 3. 覆盖形态：陈旧可解析/空文件旧/非法 JSON 旧/`null` 旧/新鲜可解析/新鲜空文件拒；
 *    另验可解析锁的年龄口径（缺 `startedAt` 退回 mtime、`startedAt` 优先于 mtime）、
 *    坏锁不再堵死只读状态读取、跨插件全局锁（`global.lock`）走同一判据。
 *
 * 取数与执行全用假件；锁与任务落盘是真的（临时家目录 + 临时使用范围）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { createUpdateDiskPorts } from '../dist/core/disk.js'
import { createUpdateQueuePorts } from '../dist/core/queue/ports.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const OLD_VERSION = '1.0.0'
const NEW_VERSION = '2.0.0'
const NOW = 1_000_000
const PREFIX = 'p181'
const PLUGIN_ID = 'issue-181-plugin'
const HOUR_MS = 60 * 60_000

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

/** 真落盘：只覆盖取数与执行；锁/任务读写必须走真实磁盘端口。 */
function makeHost({ home, profile, installedNow }) {
  let random = 0
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
        readInstalled: async () => eligibleEnv({ home, profile, installedVersion: installedNow.current() }),
        runInstall: async () => {
          installedNow.advance(NEW_VERSION)
        },
      },
    },
    { pluginId: PLUGIN_ID, prefix: PREFIX, targetPackageName: TARGET }
  )
}

function makeInstalledState() {
  let version = OLD_VERSION
  return {
    current: () => version,
    advance: (next) => {
      version = next
    },
  }
}

/** 锁位与宿主同一处：都用 createUpdateDiskPorts 算出来的 pathsForUpdate。 */
function lockPaths(home, profile) {
  const disk = createUpdateDiskPorts(home, PLUGIN_ID, profile)
  assert.ok(disk.paths, '磁盘端口必须给出锁路径')
  mkdirSync(disk.paths.directory, { recursive: true })
  return disk.paths
}

/** 跨插件全局锁位与宿主同一处：都用 createUpdateQueuePorts 算出来的 paths。 */
function queueLockPath(home, profile) {
  const queue = createUpdateQueuePorts(home, profile)
  assert.ok(queue.paths, '队列端口必须给出全局锁路径')
  mkdirSync(queue.paths.directory, { recursive: true })
  return queue.paths.lock
}

function writeLockAt(lockPath, content, ageMs) {
  writeFileSync(lockPath, content)
  if (ageMs) {
    const stamp = new Date(Date.now() - ageMs)
    utimesSync(lockPath, stamp, stamp)
  }
}

function writeLock(paths, content, ageMs) {
  writeLockAt(paths.lock, content, ageMs)
}

function tmpLeftovers(paths) {
  return readdirSync(paths.directory).filter((name) => name.endsWith('.tmp'))
}

async function status(host) {
  const out = await host.handlers[`${PREFIX}.updateStatus`]({})
  assert.equal(out.ok, true, `状态应成功：${JSON.stringify(out)}`)
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

async function waitForUnlock(paths, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && existsSync(paths.lock)) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return !existsSync(paths.lock)
}

async function waitForMissing(filename, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && existsSync(filename)) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return !existsSync(filename)
}

/** 走公开电话：检查 → 安装；返回安装结果（成功时后台异步继续）。 */
async function install(host, requestId) {
  const checked = await host.handlers[`${PREFIX}.updateCheck`]({})
  assert.equal(checked.ok, true, `检查应成功：${JSON.stringify(checked)}`)
  return host.handlers[`${PREFIX}.updateInstall`]({ checkId: checked.receipt.checkId, requestId })
}

function makeScratch({ lockContent, ageMs }) {
  const home = makeTmp('dpu-181-home-')
  const profile = makeTmp('dpu-181-profile-')
  const state = makeInstalledState()
  const host = makeHost({ home, profile, installedNow: state })
  const paths = lockPaths(home, profile)
  if (lockContent !== undefined) writeLock(paths, lockContent, ageMs)
  return { home, profile, host, state, paths }
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

process.on('exit', () => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #181：陈旧锁按时间回收', () => {
  it('一小时前的合法锁：回收并装成功，放锁后不留锁也不留 *.tmp', async () => {
    const { host, paths } = makeScratch({
      lockContent: JSON.stringify({ id: 'old-job', pid: 424242, startedAt: Date.now() - HOUR_MS }),
      ageMs: HOUR_MS,
    })
    const started = await install(host, 'req-181-stale')
    assert.equal(started.ok, true, `陈旧锁应被回收后继续安装：${JSON.stringify(started)}`)

    await waitForState(host, ['restart-required', 'completed'])
    await waitForUnlock(paths, 3000)
    assert.equal(existsSync(paths.lock), false, '成功路径必须放锁')
    assert.deepEqual(tmpLeftovers(paths), [], '不留临时锁文件')
  })

  it('空文件旧 mtime：回收并把包装成功', async () => {
    const { host } = makeScratch({ lockContent: '', ageMs: HOUR_MS })
    const started = await install(host, 'req-181-empty-old')
    assert.equal(started.ok, true, `空文件旧锁应被回收：${JSON.stringify(started)}`)
    await waitForState(host, ['restart-required', 'completed'])
  })

  it('非法 JSON 旧 mtime：回收并装成功', async () => {
    const { host } = makeScratch({ lockContent: '{"id": "half', ageMs: HOUR_MS })
    const started = await install(host, 'req-181-badjson-old')
    assert.equal(started.ok, true, `非法 JSON 旧锁应被回收：${JSON.stringify(started)}`)
    await waitForState(host, ['restart-required', 'completed'])
  })

  it('内容 null 旧 mtime：回收并装成功', async () => {
    const { host } = makeScratch({ lockContent: 'null', ageMs: HOUR_MS })
    const started = await install(host, 'req-181-null-old')
    assert.equal(started.ok, true, `null 旧锁应被回收：${JSON.stringify(started)}`)
    await waitForState(host, ['restart-required', 'completed'])
  })
})

describe('issue #181：新鲜锁不许被抢', () => {
  it('别人正在装（可解析且新鲜）：拒 update-busy，锁里的主人不被改', async () => {
    const live = JSON.stringify({ id: 'live-job', pid: 777, startedAt: Date.now() })
    const { host, paths } = makeScratch({ lockContent: live })
    const out = await install(host, 'req-181-live')
    assert.equal(out.ok, false, '新鲜锁必须拒绝')
    assert.equal(out.error, 'update-busy')
    assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).id, 'live-job', '拒的时候不许改别人的锁')
  })

  it('新鲜空文件（崩溃瞬间形态）：保守拒绝，不误抢', async () => {
    const { host, paths } = makeScratch({ lockContent: '', ageMs: 0 })
    const out = await install(host, 'req-181-empty-fresh')
    assert.equal(out.ok, false)
    assert.equal(out.error, 'update-busy')
    assert.equal(existsSync(paths.lock), true, '拒的时候锁还在')
  })
})

describe('issue #181：可解析锁的年龄口径（startedAt 优先，缺格退回 mtime）', () => {
  it('可解析但缺 startedAt：退回 mtime，判陈旧并回收装成功', async () => {
    const { host } = makeScratch({ lockContent: JSON.stringify({ id: 'no-stamp', pid: 1 }), ageMs: HOUR_MS })
    const started = await install(host, 'req-181-no-stamp')
    assert.equal(started.ok, true, `缺 startedAt 的旧锁应按 mtime 判陈旧：${JSON.stringify(started)}`)
    await waitForState(host, ['restart-required', 'completed'])
  })

  it('startedAt 新鲜但 mtime 很旧：startedAt 优先，拒 update-busy', async () => {
    const live = JSON.stringify({ id: 'stamp-fresh', pid: 1, startedAt: Date.now() })
    const { host, paths } = makeScratch({ lockContent: live, ageMs: HOUR_MS })
    const out = await install(host, 'req-181-stamp-priority')
    assert.equal(out.ok, false, '锁里说自己是新鲜的，就不许按 mtime 抢')
    assert.equal(out.error, 'update-busy')
    assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).id, 'stamp-fresh')
  })
})

describe('issue #181：坏锁不再堵死只读状态读取', () => {
  it('新鲜非法 JSON 安装锁：只读状态仍成功，安装按 update-busy 拒', async () => {
    const { host, paths } = makeScratch({ lockContent: '{"id": "half', ageMs: 0 })
    await status(host) // 不再整次失败
    const out = await install(host, 'req-181-corrupt-read')
    assert.equal(out.ok, false)
    assert.equal(out.error, 'update-busy')
    assert.equal(existsSync(paths.lock), true)
  })
})

describe('issue #181：跨插件全局锁（global.lock）同判据', () => {
  it('陈旧空 global.lock（mtime 一小时前）：回收并装成功，装完放掉全局锁、不留临时件', async () => {
    const { home, profile, host } = makeScratch({})
    const globalLock = queueLockPath(home, profile)
    writeLockAt(globalLock, '', HOUR_MS)
    const started = await install(host, 'req-181-global-stale')
    assert.equal(started.ok, true, `陈旧全局锁应被回收：${JSON.stringify(started)}`)
    await waitForState(host, ['restart-required', 'completed'])
    assert.equal(await waitForMissing(globalLock), true, '装完必须放掉全局锁')
    const leftovers = readdirSync(join(globalLock, '..')).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], '不留临时锁文件')
  })

  it('新鲜空 global.lock：拒 update-busy，锁原样还在', async () => {
    const { home, profile, host } = makeScratch({})
    const globalLock = queueLockPath(home, profile)
    writeLockAt(globalLock, '', 0)
    const out = await install(host, 'req-181-global-fresh')
    assert.equal(out.ok, false, '新鲜全局锁必须拒绝')
    assert.equal(out.error, 'update-busy')
    assert.equal(existsSync(globalLock), true, '拒的时候全局锁还在')
  })
})
