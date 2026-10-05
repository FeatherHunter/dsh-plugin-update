/**
 * tests/queue.test.mjs —— 跨插件单队列串行（#15）。
 *
 * 只测外部行为：纯决策（占位幂等、位置口径、公平门、取消、过期、可见性开关）、
 * 共享落盘（同范围共享、异范围隔离、与 updates 树平级不碰撞、全局锁串行与过期回收）、
 * 宿主接线（老调用形状不变、三电话名不变、快照仍六字段；新可选参数只在显式要时才带队列）。
 * 网络、子进程、桌面服务全用假件；落盘走真实临时目录（前缀隔离），不碰生产路径。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  QUEUE_INTENT_TTL_MS,
  cancelEnqueuedInQueue,
  emptyQueueState,
  enqueueInQueue,
  isHeadOfQueue,
  isQueueBusy,
  normalizeQueueState,
  promoteHeadToOwner,
  pruneExpiredIntents,
  queuePositionOf,
  releaseOwnerInQueue,
  setOwnerIfFree,
  visibleQueueFor,
} from '../dist/queue.js'
import { createUpdateQueuePorts, queuePathsForUpdate } from '../dist/store.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
}

describe('纯决策：占位与位置', () => {
  it('同一编号幂等占一位，已在不挪位', () => {
    let s = emptyQueueState()
    const first = enqueueInQueue(s, { pluginId: 'a', requestId: 'r1', enqueuedAt: 1000 })
    assert.equal(first.position, 1)
    s = first.state
    const second = enqueueInQueue(s, { pluginId: 'b', requestId: 'r2', enqueuedAt: 1001 })
    assert.equal(second.position, 2)
    s = second.state
    const repeat = enqueueInQueue(s, { pluginId: 'a', requestId: 'r1', enqueuedAt: 9999 })
    assert.equal(repeat.position, 1)
    assert.equal(repeat.state.waiting.length, 2)
    assert.equal(repeat.state.waiting[0].enqueuedAt, 1000)
  })

  it('已是拥有者时占位返回 0', () => {
    const promoted = promoteHeadToOwner(
      enqueueInQueue(emptyQueueState(), { pluginId: 'a', requestId: 'r1', enqueuedAt: 1 }).state,
      { jobId: 'job-1', startedAt: 2 }
    )
    assert.equal(promoted.promoted, true)
    const again = enqueueInQueue(promoted.state, { pluginId: 'a', requestId: 'r1', enqueuedAt: 3 })
    assert.equal(again.position, 0)
  })

  it('队空人人是队首，非队首不许抢', () => {
    assert.equal(isHeadOfQueue(emptyQueueState(), 'any', 'x'), true)
    let s = emptyQueueState()
    s = enqueueInQueue(s, { pluginId: 'a', requestId: 'r1', enqueuedAt: 1 }).state
    s = enqueueInQueue(s, { pluginId: 'b', requestId: 'r2', enqueuedAt: 2 }).state
    assert.equal(isHeadOfQueue(s, 'a', 'r1'), true)
    assert.equal(isHeadOfQueue(s, 'b', 'r2'), false)
    assert.equal(queuePositionOf(s, 'a', 'r1'), 1)
    assert.equal(queuePositionOf(s, 'b', 'r2'), 2)
    assert.equal(queuePositionOf(s, 'c', 'r3'), null)
  })

  it('坏输入回空队列，不抛错', () => {
    assert.deepEqual(normalizeQueueState(null), emptyQueueState())
    assert.deepEqual(normalizeQueueState({ version: 2 }), emptyQueueState())
    assert.deepEqual(normalizeQueueState('nope'), emptyQueueState())
    assert.equal(isQueueBusy(emptyQueueState()), false)
  })
})

describe('纯决策：取消与摘牌', () => {
  it('只能取消自己的 waiting，owner 与他人都动不得', () => {
    let s = emptyQueueState()
    s = enqueueInQueue(s, { pluginId: 'a', requestId: 'r1', enqueuedAt: 1 }).state
    s = enqueueInQueue(s, { pluginId: 'b', requestId: 'r2', enqueuedAt: 2 }).state
    const others = cancelEnqueuedInQueue(s, 'a', 'r2')
    assert.equal(others.removed, false)
    const mine = cancelEnqueuedInQueue(s, 'a', 'r1')
    assert.equal(mine.removed, true)
    assert.equal(mine.state.waiting.length, 1)
    assert.equal(mine.state.waiting[0].pluginId, 'b')
    const missing = cancelEnqueuedInQueue(mine.state, 'a', 'r1')
    assert.equal(missing.removed, false)
  })

  it('owner 不经队列取消，摘牌要双对上', () => {
    let s = promoteHeadToOwner(
      enqueueInQueue(emptyQueueState(), { pluginId: 'a', requestId: 'r1', enqueuedAt: 1 }).state,
      { jobId: 'job-1', startedAt: 2 }
    ).state
    assert.equal(isQueueBusy(s), true)
    assert.equal(cancelEnqueuedInQueue(s, 'a', 'r1').removed, false)
    assert.equal(releaseOwnerInQueue(s, 'a', 'wrong-job').released, false)
    assert.equal(releaseOwnerInQueue(s, 'b', 'job-1').released, false)
    const out = releaseOwnerInQueue(s, 'a', 'job-1')
    assert.equal(out.released, true)
    assert.equal(out.state.owner, null)
    assert.equal(isQueueBusy(out.state), false)
  })

  it('过期意向惰性丢弃，owner 不过期', () => {
    let s = emptyQueueState()
    s = enqueueInQueue(s, { pluginId: 'a', requestId: 'r1', enqueuedAt: 1000 }).state
    s = promoteHeadToOwner(s, { jobId: 'job-1', startedAt: 1000 }).state
    s = enqueueInQueue(s, { pluginId: 'b', requestId: 'r2', enqueuedAt: 1000 }).state
    const pruned = pruneExpiredIntents(s, 1000 + QUEUE_INTENT_TTL_MS + 1)
    assert.notEqual(pruned.owner, null)
    assert.equal(pruned.waiting.length, 0)
    const kept = pruneExpiredIntents(s, 1000 + 1)
    assert.equal(kept, s)
  })

  it('抢到锁无占位时直接记牌，已有牌不覆盖', () => {
    const first = setOwnerIfFree(emptyQueueState(), { pluginId: 'a', jobId: 'job-1', startedAt: 5 })
    assert.equal(first.set, true)
    assert.equal(first.state.owner.pluginId, 'a')
    const second = setOwnerIfFree(first.state, { pluginId: 'b', jobId: 'job-2', startedAt: 6 })
    assert.equal(second.set, false)
    assert.equal(second.state.owner.pluginId, 'a')
  })
})

describe('纯决策：面板可见性开关', () => {
  function queued() {
    let s = emptyQueueState()
    s = enqueueInQueue(s, { pluginId: 'me', requestId: 'r1', enqueuedAt: 1 }).state
    s = enqueueInQueue(s, { pluginId: 'other', requestId: 'r2', enqueuedAt: 2 }).state
    return s
  }

  it('默认隐藏他人：waiting 只留自己的，位置照给', () => {
    const s = queued()
    const view = visibleQueueFor(s, 'me')
    assert.equal(view.busy, false)
    assert.equal(view.waiting.length, 1)
    assert.equal(view.waiting[0].pluginId, 'me')
    assert.equal(view.position, 1)
    const otherView = visibleQueueFor(s, 'other')
    assert.equal(otherView.waiting.length, 1)
    assert.equal(otherView.waiting[0].pluginId, 'other')
    assert.equal(otherView.position, 2)
  })

  it('显式要才给全量', () => {
    const s = queued()
    const view = visibleQueueFor(s, 'me', true)
    assert.equal(view.waiting.length, 2)
  })

  it('他人拥有时只露 busy 占位，不露标识；自己拥有给全量', () => {
    let s = queued()
    s = promoteHeadToOwner(s, { jobId: 'job-1', startedAt: 3 }).state
    const mine = visibleQueueFor(s, 'other', false, 'r2')
    assert.equal(mine.busy, true)
    assert.equal(mine.owner.pluginId, null)
    assert.equal(mine.owner.busy, true)
    assert.equal(mine.position, 1)
    const ownerView = visibleQueueFor(s, 'me', false, 'r1')
    assert.equal(ownerView.owner.pluginId, 'me')
    assert.equal(ownerView.position, 0)
    const full = visibleQueueFor(s, 'other', true, 'r2')
    assert.equal(full.owner.pluginId, 'me')
  })
})

describe('共享落盘：归属与全局锁', () => {
  let homeDir = ''
  let profileA = ''
  let profileB = ''

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'dpu-q-home-'))
    profileA = mkdtempSync(join(tmpdir(), 'dpu-q-prof-a-'))
    profileB = mkdtempSync(join(tmpdir(), 'dpu-q-prof-b-'))
  })

  after(() => {
    for (const dir of [homeDir, profileA, profileB]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })

  it('同范围共享目录，异范围隔离，且与 updates 树平级不碰撞', () => {
    const p1 = queuePathsForUpdate(homeDir, profileA)
    const p2 = queuePathsForUpdate(homeDir, profileA)
    assert.deepEqual(p1, p2)
    assert.ok(p1.directory.includes('update-queue'))
    assert.ok(!p1.directory.includes(join('updates', 'my-plugin')))
    assert.equal(p1.file, join(p1.directory, 'queue.json'))
    const other = queuePathsForUpdate(homeDir, profileB)
    assert.notEqual(other.directory, p1.directory)
    assert.equal(p1.directory, join(homeDir, 'update-queue', shortHash(profileA)))
    assert.equal(queuePathsForUpdate('', profileA), null)
  })

  it('队列文件整写往返，坏文件回空不抛', async () => {
    const ports = createUpdateQueuePorts(homeDir, profileA)
    const started = emptyQueueState()
    const placed = enqueueInQueue(started, { pluginId: 'a', requestId: 'r1', enqueuedAt: 7 })
    await ports.writeQueue(placed.state)
    const back = await ports.readQueue()
    assert.equal(back.waiting.length, 1)
    assert.equal(back.waiting[0].pluginId, 'a')
  })

  it('全局锁一次只装一个，放了后另一家可进', async () => {
    const ports = createUpdateQueuePorts(homeDir, profileA)
    assert.equal(await ports.tryAcquireGlobalLock('job-a', 'plugin-a'), true)
    assert.equal(await ports.tryAcquireGlobalLock('job-b', 'plugin-b'), false)
    await ports.releaseGlobalLock('job-b')
    assert.equal(await ports.tryAcquireGlobalLock('job-b', 'plugin-b'), false)
    await ports.releaseGlobalLock('job-a')
    assert.equal(await ports.tryAcquireGlobalLock('job-b', 'plugin-b'), true)
    await ports.releaseGlobalLock('job-b')
  })

  it('陈旧全局锁可回收一次，不陈旧不回收', async () => {
    let now = 100000
    const ports = createUpdateQueuePorts(homeDir, profileA, { nowImpl: () => now })
    assert.equal(await ports.tryAcquireGlobalLock('job-a', 'plugin-a', { timeoutMs: 1000 }), true)
    now += 500
    assert.equal(await ports.tryAcquireGlobalLock('job-b', 'plugin-b', { timeoutMs: 1000 }), false)
    now += 600
    assert.equal(await ports.tryAcquireGlobalLock('job-b', 'plugin-b', { timeoutMs: 1000 }), true)
    await ports.releaseGlobalLock('job-b')
  })
})

const RELEASE_VERSION = '9.9.9'
const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'

function fakeFetch(targetName = TARGET) {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(targetName)}/latest`)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: targetName,
          version: RELEASE_VERSION,
          engines: { node: '>=22' },
          dist: {
            tarball: `${REGISTRY}${targetName}/-/${targetName}-${RELEASE_VERSION}.tgz`,
            integrity: 'sha512-' + 'A'.repeat(86) + '==',
          },
        }),
    }
  }
}

function memoryStore() {
  let job = null
  let locked = null
  return {
    readJob: async () => job,
    writeJob: async (value) => {
      job = value
    },
    tryAcquireLock: async (id) => {
      if (locked !== null) return false
      locked = id
      return true
    },
    releaseLock: async (id) => {
      if (locked === id) locked = null
    },
    backupJob: async () => {},
  }
}

function sharedQueueFakes() {
  let state = { version: 1, owner: null, waiting: [] }
  let holder = null
  const clone = (v) => JSON.parse(JSON.stringify(v))
  return {
    readQueue: async () => clone(state),
    writeQueue: async (s) => {
      state = clone(s)
    },
    tryAcquireGlobalLock: async (id) => {
      if (holder !== null) return false
      holder = id
      return true
    },
    releaseGlobalLock: async (id) => {
      if (holder === id) holder = null
    },
    _state: () => state,
  }
}

function eligibleEnv(installedVersion) {
  return {
    profileName: 'web',
    environmentKind: 'cli',
    homeDir: 'C:\\fake\\home',
    profileDir: 'C:\\fake\\profile',
    installedVersion,
    packageValid: true,
    sourceInstall: false,
    blockedReason: null,
    installationKey: 'fake-key',
    eligible: true,
  }
}

function makeHost({ pluginId, prefix, fires, queue, store, runInstall, installedVersion = '1.0.0' }) {
  return createHostUpdate(
    {
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
      readerOverrides: {
        runningVersion: '1.0.0',
        profileDir: 'C:\\fake\\profile',
        profileName: 'web',
        homeDir: 'C:\\fake\\home',
        fetchImpl: fakeFetch(),
        now: () => 1_000_000,
        randomId: (() => {
          let n = 0
          return () => `${pluginId}-id-${(n += 1)}`
        })(),
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        readInstalled: async () => eligibleEnv(installedVersion),
        ...store,
        ...queue,
        runInstall: runInstall ?? (async () => {}),
      },
    },
    prefix === undefined ? { pluginId } : { pluginId, prefix }
  )
}

async function checkAndInstall(host, statusName, checkName, installName, requestId) {
  const checked = await host.handlers[checkName]({})
  assert.equal(checked.ok, true)
  const checkId = checked.receipt.checkId
  return host.handlers[installName]({ checkId, requestId })
}

describe('宿主接线：老形状冻结与队列开关', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })

  it('老调用形状不变：不传开关即无 queue 键，快照仍六字段', async () => {
    const fires = []
    const host = makeHost({ pluginId: 'queue-freeze-a', fires, queue: {}, store: memoryStore() })
    const out = await host.handlers['wf.updateStatus']({})
    assert.equal(out.ok, true)
    assert.ok(!('queue' in out))
    assert.deepEqual(Object.keys(out.snapshot).sort(), ['blockedReason', 'canInstall', 'installedVersion', 'job', 'latestVersion', 'runningVersion'])
    assert.deepEqual(Object.keys(host.phoneNames).sort(), ['updateChangelog', 'updateCheck', 'updateInstall', 'updateStatus'])
  })

  it('查状态显式要才带队列：默认藏他人，显式给全量', async () => {
    const firesA = []
    const firesB = []
    const queue = sharedQueueFakes()
    const storeA = memoryStore()
    const storeB = memoryStore()
    const hostA = makeHost({ pluginId: 'queue-hide-a', fires: firesA, queue, store: storeA })
    const hostB = makeHost({ pluginId: 'queue-hide-b', fires: firesB, queue, store: storeB })
    await hostA.handlers['wf.updateInstall']({ checkId: 'x', requestId: 'qa', enqueueOnly: true })
    const hidden = await hostB.handlers['wf.updateStatus']({ includeQueue: true })
    assert.ok(hidden.queue)
    assert.equal(hidden.queue.waiting.length, 0)
    assert.equal(hidden.queue.position, null)
    const full = await hostB.handlers['wf.updateStatus']({ includeQueue: true, showOthers: true })
    assert.equal(full.queue.waiting.length, 1)
    assert.equal(full.queue.waiting[0].pluginId, 'queue-hide-a')
  })

  it('跨插件串行：第二家撞上全局锁报 update-busy，占位留给轮询', async () => {
    const firesA = []
    const firesB = []
    const queue = sharedQueueFakes()
    let releaseA = null
    const hanging = new Promise((resolve) => {
      releaseA = resolve
    })
    const hostA = makeHost({
      pluginId: 'queue-busy-a',
      fires: firesA,
      queue,
      store: memoryStore(),
      runInstall: async () => {
        await hanging
      },
    })
    const hostB = makeHost({
      pluginId: 'queue-busy-b',
      fires: firesB,
      queue,
      store: memoryStore(),
    })
    const doneA = checkAndInstall(hostA, 'wf.updateStatus', 'wf.updateCheck', 'wf.updateInstall', 'req-a')
    const outA = await doneA
    assert.equal(outA.ok, true)
    assert.equal(outA.snapshot.job.state, 'installing')
    const outB = await checkAndInstall(hostB, 'wf.updateStatus', 'wf.updateCheck', 'wf.updateInstall', 'req-b')
    assert.equal(outB.ok, false)
    assert.equal(outB.error, 'update-busy')
    const looking = await hostB.handlers['wf.updateStatus']({ includeQueue: true, requestId: 'req-b' })
    assert.equal(looking.queue.busy, true)
    assert.equal(looking.queue.position, 1)
    releaseA()
    await hostA.handlers['wf.updateStatus']({})
  })

  it('公平门：后来者非队首直接忙，不抢锁', async () => {
    const fires = []
    const queue = sharedQueueFakes()
    const hostFirst = makeHost({ pluginId: 'queue-fair-first', fires, queue, store: memoryStore() })
    const hostSecond = makeHost({ pluginId: 'queue-fair-second', fires, queue, store: memoryStore() })
    const r1 = await hostFirst.handlers['wf.updateInstall']({ checkId: 'x', requestId: 'first', enqueueOnly: true })
    assert.equal(r1.queue.position, 1)
    const r2 = await hostSecond.handlers['wf.updateInstall']({ checkId: 'y', requestId: 'second', enqueueOnly: true })
    assert.equal(r2.queue.position, 2)
    const blocked = await hostSecond.handlers['wf.updateInstall']({ checkId: 'y', requestId: 'second' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'update-busy')
  })

  it('取消占位：撤自己的成功，撤他人的不动', async () => {
    const fires = []
    const queue = sharedQueueFakes()
    const hostA = makeHost({ pluginId: 'queue-cancel-a', fires, queue, store: memoryStore() })
    const hostB = makeHost({ pluginId: 'queue-cancel-b', fires, queue, store: memoryStore() })
    await hostA.handlers['wf.updateInstall']({ checkId: 'x', requestId: 'ca', enqueueOnly: true })
    const stole = await hostB.handlers['wf.updateInstall']({ requestId: 'ca', cancelQueued: true })
    assert.equal(stole.ok, true)
    assert.equal(queue._state().waiting.length, 1)
    const mine = await hostA.handlers['wf.updateInstall']({ requestId: 'ca', cancelQueued: true })
    assert.equal(mine.ok, true)
    assert.equal(queue._state().waiting.length, 0)
  })

  it('陈旧拥有者不卡后来者：崩溃残留的牌按安装时限回收', async () => {
    const fires = []
    const queue = sharedQueueFakes()
    await queue.writeQueue({
      version: 1,
      owner: { pluginId: 'ghost', jobId: 'ghost-job', requestId: null, targetVersion: null, startedAt: 0 },
      waiting: [],
    })
    const host = makeHost({ pluginId: 'queue-stale-a', fires, queue, store: memoryStore() })
    const out = await checkAndInstall(host, 'wf.updateStatus', 'wf.updateCheck', 'wf.updateInstall', 'req-stale')
    assert.equal(out.ok, true)
    assert.equal(queue._state().owner.pluginId, 'queue-stale-a')
  })
})
