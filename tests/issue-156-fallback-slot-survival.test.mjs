/**
 * tests/issue-156-fallback-slot-survival.test.mjs —— #156 凭证槽的存活（对抗审查 B2 回归锁）。
 *
 * 事实（2026-10-17 对抗审查实证）：宿主侧 `sharedReader` 是**单例**（src/host/capabilities.ts 的 sharedReader），
 * 批量面板逐家打电话时每取下一家的读取器都会把上一家丢出缓存；逐行路径也活不过一次
 * 1.5s 轮询（轮询会为每一家重建读取器）。凭证槽若活在被丢掉的读取器实例里，
 * 「装合规版」在 N≥2 的批量里必然 check-expired——确认时已是新读取器、槽是空的。
 *
 * 这里钉住的正是那条性质：**同一安装指纹下，读取器重建之后凭证仍然可用**；
 * 以及反向面：别家的决议既不会抹掉本家的凭证，也不会替本家装上版本。
 * 时间与源全假件：不联网、不落盘、不起进程。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateCore, __resetFallbackSlots } from '../dist/core/service.js'
import { resolveCompliantVersion } from '../dist/shared/compliant.js'

const TARGET = 'dsh-demo-widget'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'D'.repeat(86) + '=='
const NOW = 2_000_000_000_000
const HOUR = 3_600_000

const PUBLISHED = {
  '1.66.26': new Date(NOW - 30 * HOUR).toISOString(),
  '1.66.27': new Date(NOW - 25 * HOUR).toISOString(),
  '1.66.28': new Date(NOW - 1 * HOUR).toISOString(),
}

function versionBody(version) {
  return JSON.stringify({
    name: TARGET,
    version,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`, integrity: INTEGRITY },
  })
}

function fakeFetch() {
  return async (url) => {
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}`) {
      return {
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            name: TARGET,
            'dist-tags': { latest: '1.66.28' },
            time: { ...PUBLISHED, created: PUBLISHED['1.66.26'], modified: PUBLISHED['1.66.28'] },
          }),
      }
    }
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}/latest`) return { ok: true, headers: { get: () => null }, text: async () => versionBody('1.66.28') }
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}/1.66.27`) return { ok: true, headers: { get: () => null }, text: async () => versionBody('1.66.27') }
    if (url === `${REGISTRY}${encodeURIComponent(TARGET)}/1.66.26`) return { ok: true, headers: { get: () => null }, text: async () => versionBody('1.66.26') }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' }
  }
}

/** 每家的任务盘／锁各自独立（批量里每家一个目标运行时）。 */
function memoryJobStore() {
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

/** 一家读取器的零件：installationKey 是"哪一家"的唯一标识（凭证槽按它寻址）。 */
function portsFor(installationKey, installedVersion = '1.0.0') {
  const store = memoryJobStore()
  const installs = []
  return {
    installs,
    ports: {
      readRunningVersion: () => installedVersion,
      readInstalled: async () => ({
        profileName: 'web',
        environmentKind: 'cli',
        homeDir: null,
        profileDir: null,
        installedVersion,
        packageValid: true,
        sourceInstall: false,
        blockedReason: null,
        installationKey,
        eligible: true,
      }),
      fetchImpl: fakeFetch(),
      now: () => NOW,
      randomId: (() => {
        let n = 0
        return () => `${installationKey}-id-${(n += 1)}`
      })(),
      nodeVersion: '22.0.0',
      readJob: store.readJob,
      writeJob: store.writeJob,
      tryAcquireLock: store.tryAcquireLock,
      releaseLock: store.releaseLock,
      backupJob: store.backupJob,
      runInstall: async (args) => {
        installs.push(args)
      },
      resolveCompliantVersion,
      targetPackageName: TARGET,
    },
  }
}

const FALLBACK_INPUT = { targetVersion: '1.66.28', windowMs: 24 * HOUR, windowSource: 'message', blame: 'target' }

describe('#156 凭证槽在读取器重建后仍可用（B2 回归）', () => {
  beforeEach(() => {
    __resetFallbackSlots()
  })

  it('同一安装指纹：第一家决议后读取器被淘汰重建，凭同一凭证仍能装候选', async () => {
    const first = portsFor('key-p')
    const decided = await createUpdateCore(first.ports).checkFallback(FALLBACK_INPUT)
    assert.equal(decided.verdict.kind, 'downgrade-available')
    assert.equal(decided.candidate, '1.66.27')

    // 别家读取器被建出来（批量逐家打电话）→ 单例缓存把第一家丢出去。
    const other = portsFor('key-q')
    const otherDecided = await createUpdateCore(other.ports).checkFallback(FALLBACK_INPUT)
    assert.equal(otherDecided.candidate, '1.66.27')

    // 第一家被淘汰后重建：新实例、同一安装指纹——凭证必须还活着。
    const rebuilt = createUpdateCore(first.ports)
    const snap = await rebuilt.install({
      checkId: decided.receipt.checkId,
      requestId: 'req-survive',
      version: decided.candidate,
    })
    assert.equal(snap.job && snap.job.state, 'installing')
    assert.equal(snap.job && snap.job.targetVersion, '1.66.27')
  })

  it('别家的决议既不抹掉本家的槽，也不替本家装：两家各自凭自己的凭证装自己的候选', async () => {
    const p = portsFor('key-p')
    const q = portsFor('key-q')
    const decidedP = await createUpdateCore(p.ports).checkFallback(FALLBACK_INPUT)
    const decidedQ = await createUpdateCore(q.ports).checkFallback(FALLBACK_INPUT)

    // 交错确认，且中间再建一次别家读取器（复现"每取下一家就丢上一家"）。
    const rebuiltP = createUpdateCore(p.ports)
    const rebuiltQ = createUpdateCore(q.ports)
    const snapQ = await rebuiltQ.install({ checkId: decidedQ.receipt.checkId, requestId: 'req-q', version: decidedQ.candidate })
    const snapP = await rebuiltP.install({ checkId: decidedP.receipt.checkId, requestId: 'req-p', version: decidedP.candidate })
    assert.equal(snapP.job.targetVersion, '1.66.27')
    assert.equal(snapQ.job.targetVersion, '1.66.27')

    // 而且各自只装了自己的那一次：p 家的执行器只见到 p 的安装。
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(p.installs.length, 1)
    assert.equal(q.installs.length, 1)
    assert.equal(p.installs[0].version, '1.66.27')
  })

  it('拿别家（另一安装指纹）的凭证装候选：check-expired，不认跨家凭证', async () => {
    const p = portsFor('key-p')
    const decidedP = await createUpdateCore(p.ports).checkFallback(FALLBACK_INPUT)
    const q = portsFor('key-q')
    const rebuiltQ = createUpdateCore(q.ports)
    await assert.rejects(
      () => rebuiltQ.install({ checkId: decidedP.receipt.checkId, requestId: 'req-cross', version: decidedP.candidate }),
      /check-expired/
    )
  })

  it('同一指纹走一次普通检查：该指纹的槽清掉，重建后旧凭证同样过期（决议不跨检查复用）', async () => {
    const p = portsFor('key-p')
    const first = createUpdateCore(p.ports)
    const decided = await first.checkFallback(FALLBACK_INPUT)
    await first.check()
    const rebuilt = createUpdateCore(p.ports)
    await assert.rejects(
      () => rebuilt.install({ checkId: decided.receipt.checkId, requestId: 'req-stale', version: decided.candidate }),
      /check-expired/
    )
  })

  it('凭证到期后重建也不认：模块级槽不延长有效期', async () => {
    const p = portsFor('key-p')
    let clock = NOW
    p.ports.now = () => clock
    const decided = await createUpdateCore(p.ports).checkFallback(FALLBACK_INPUT)
    clock = NOW + 11 * 60_000
    const rebuilt = createUpdateCore(p.ports)
    await assert.rejects(
      () => rebuilt.install({ checkId: decided.receipt.checkId, requestId: 'req-expired', version: decided.candidate }),
      /check-expired/
    )
  })
})
