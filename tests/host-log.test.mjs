/**
 * tests/host-log.test.mjs —— issue #124 宿主/中立侧事件接线：真有行、口径对、噪声被治住。
 *
 * 只测外部行为：经公开电话驱动，在注入的落点上收集行，然后断言
 * （1）每个环节真落一条、字段集合与 `event-list.update.json` 逐字一致；
 * （2）轮询抑制真的生效（连续 N 次同状态 `updateStatus` 零常驻行）；
 * （3）负向断言：任何一行都不含路径、URL、令牌原文（ADR-0006）。
 * 网络、落盘、子进程全用假件，不碰真机。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const RELEASE_VERSION = '9.9.9'

function fakeFetch({ status = 200, failing = false } = {}) {
  return async () => {
    if (failing) throw new Error('network down')
    return {
      ok: true,
      status,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: TARGET,
          version: RELEASE_VERSION,
          engines: { node: '>=22' },
          dist: {
            tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${RELEASE_VERSION}.tgz`,
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

/** 装好之后磁盘上就是新版（运行版仍是旧的 → 需要重启）。 */
function makeHost({ pluginId = TARGET, installed = '1.0.0', fetchImpl = fakeFetch() } = {}) {
  const fires = []
  let onDisk = installed
  const host = createHostUpdate(
    {
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
      readerOverrides: {
        runningVersion: '1.0.0',
        profileDir: 'C:\\fake\\profile',
        profileName: 'web',
        homeDir: 'C:\\fake\\home',
        fetchImpl,
        now: () => 1_000_000,
        randomId: (() => {
          let n = 0
          return () => `id-${(n += 1)}`
        })(),
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        readInstalled: async () => eligibleEnv(onDisk),
        ...memoryStore(),
        runInstall: async () => {
          onDisk = RELEASE_VERSION
        },
      },
    },
    { pluginId },
  )
  return { host, fires }
}

const rows = (fires, event) => fires.filter((f) => f.event === event)
const keysOf = (fields) => Object.keys(fields).sort()

/** 等一行异步落点（安装是后台跑的，调用方不干等）。 */
async function waitForEvent(fires, event) {
  for (let i = 0; i < 200 && rows(fires, event).length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return rows(fires, event)
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

describe('#124 检查环节：registry.fetch / channel.decide / check.start / check.done', () => {
  it('成功检查落三行，字段集合与事件清单逐字一致', async () => {
    const { host, fires } = makeHost()
    await host.handlers['wf.updateCheck']({})

    const fetchRows = rows(fires, 'update.registry.fetch')
    assert.equal(fetchRows.length, 1)
    assert.deepEqual(keysOf(fetchRows[0].fields), ['httpStatus', 'latencyMs', 'registryHost'])
    assert.equal(fetchRows[0].fields.httpStatus, 200)
    assert.equal(fetchRows[0].fields.registryHost, 'registry.npmjs.org')
    assert.equal(typeof fetchRows[0].fields.latencyMs, 'number')

    const decide = rows(fires, 'update.channel.decide')
    assert.equal(decide.length, 1)
    assert.deepEqual(decide[0].fields, { channel: 'stable', reason: 'stable', from: '1.0.0', to: RELEASE_VERSION })

    const done = rows(fires, 'update.check.done')
    assert.equal(done.length, 1)
    assert.deepEqual(keysOf(done[0].fields), ['channel', 'current', 'latencyMs', 'latest', 'ok', 'source'])
    assert.equal(done[0].fields.ok, true)
    assert.equal(done[0].fields.current, '1.0.0')
    assert.equal(done[0].fields.latest, RELEASE_VERSION)
    assert.equal(done[0].fields.source, 'registry.npmjs.org')
  })

  it('失败检查落 check.fail（stage/errorKind），既有 host.call.fail 一条不吞', async () => {
    const { host, fires } = makeHost({ fetchImpl: fakeFetch({ failing: true }) })
    const out = await host.handlers['wf.updateCheck']({})

    assert.equal(out.ok, false)
    const fail = rows(fires, 'update.check.fail')
    assert.equal(fail.length, 1)
    assert.deepEqual(fail[0].fields, { stage: 'fetch', errorKind: 'check-failed' })
    assert.equal(fail[0].level, 'warn')
    assert.equal(rows(fires, 'host.call.fail').length, 1)
    assert.equal(rows(fires, 'update.check.done').length, 0)
  })

  it('check.start 只在调用方自报触发方时落一行（宁缺勿错）', async () => {
    // 两个实例必须用不同标识：读取器按标识共享单例（#591），同标识会复用第一份落点。
    const quiet = makeHost({ pluginId: 'plugin-quiet' })
    await quiet.host.handlers['wf.updateCheck']({})
    assert.equal(rows(quiet.fires, 'update.check.start').length, 0)

    const loud = makeHost({ pluginId: 'plugin-loud' })
    await loud.host.handlers['wf.updateCheck']({ trigger: 'auto' })
    const start = rows(loud.fires, 'update.check.start')
    assert.equal(start.length, 1)
    assert.deepEqual(start[0].fields, { trigger: 'auto', source: 'registry.npmjs.org' })
  })
})

describe('#124 轮询噪声治理：status.changed 与 host.call 抑制', () => {
  it('同状态连续 5 次 updateStatus：host.call 零行（基线也不落），常驻状态行只落第一次', async () => {
    const { host, fires } = makeHost()
    for (let i = 0; i < 5; i += 1) await host.handlers['wf.updateStatus']({})

    // 轮询的第一次观测不算事件（没有可比的上次），连续同状态一律不发：N 次轮询零常驻行。
    assert.equal(rows(fires, 'host.call').length, 0)
    assert.equal(rows(fires, 'update.status.changed').length, 1)
    assert.deepEqual(rows(fires, 'update.status.changed')[0].fields, { kind: 'unknown' })
    // 按需档的轮询全量行不受抑制（开关没开时发射口自己丢，不占预算）。
    assert.equal(rows(fires, 'update.poll').length, 5)
  })

  it('状态真的变了才再落一条：检查出新版即 update-available，轮询行也只放行一次', async () => {
    const { host, fires } = makeHost()
    await host.handlers['wf.updateStatus']({})
    await host.handlers['wf.updateStatus']({})
    assert.equal(rows(fires, 'update.status.changed').length, 1)
    assert.equal(rows(fires, 'host.call').length, 0)

    await host.handlers['wf.updateCheck']({})
    const changed = rows(fires, 'update.status.changed')
    assert.equal(changed.length, 2)
    assert.deepEqual(changed[1].fields, { kind: 'update-available', latest: RELEASE_VERSION })

    await host.handlers['wf.updateStatus']({})
    assert.equal(rows(fires, 'update.status.changed').length, 2)
    // 状态变了 → 轮询行放行一次（只治噪声，不治变化），再回到同状态继续不发。
    // 只数轮询自己的行：检查电话自己有一条 host.call，不掺进这个计数。
    const pollRows = () =>
      fires.filter((f) => f.event === 'host.call' && String(f.fields.method).endsWith('.updateStatus'))
    assert.equal(pollRows().length, 1)
    await host.handlers['wf.updateStatus']({})
    assert.equal(pollRows().length, 1)
  })
})

describe('#124 安装环节：install.request / install.verify', () => {
  it('过闸门后落 install.request（from 自报即照传），装完落 verify', async () => {
    const { host, fires } = makeHost()
    const checked = await host.handlers['wf.updateCheck']({})
    assert.equal(checked.ok, true)

    const installed = await host.handlers['wf.updateInstall']({
      checkId: checked.receipt.checkId,
      requestId: 'req-1',
      from: 'batch',
    })
    assert.equal(installed.ok, true)

    const request = rows(fires, 'update.install.request')
    assert.equal(request.length, 1)
    assert.deepEqual(keysOf(request[0].fields), ['checkAgeMs', 'current', 'from', 'latest'])
    assert.equal(request[0].fields.from, 'batch')
    assert.equal(request[0].fields.current, '1.0.0')
    assert.equal(request[0].fields.latest, RELEASE_VERSION)

    const verify = await waitForEvent(fires, 'update.install.verify')
    assert.equal(verify.length, 1)
    assert.deepEqual(verify[0].fields, {
      result: 'restart-required',
      installedVersion: RELEASE_VERSION,
      pendingRestart: true,
    })
  })

  it('被闸门挡掉的安装请求不算一次意图：install.request 一条不发', async () => {
    const { host, fires } = makeHost()
    await host.handlers['wf.updateCheck']({})
    const out = await host.handlers['wf.updateInstall']({ checkId: 'nope', requestId: 'req-2' })
    assert.equal(out.ok, false)
    assert.equal(rows(fires, 'update.install.request').length, 0)
    assert.equal(rows(fires, 'update.install.verify').length, 0)
  })
})

describe('#124 负向断言：行里不出现路径、URL、令牌', () => {
  it('整条链路走完，任何一行的任何一格都不含路径/URL/令牌原文', async () => {
    const { host, fires } = makeHost()
    const checked = await host.handlers['wf.updateCheck']({ trigger: 'user' })
    await host.handlers['wf.updateInstall']({ checkId: checked.receipt.checkId, requestId: 'req-3' })
    await waitForEvent(fires, 'update.install.verify')

    const forbidden = ['C:\\', 'fake\\', 'https://', 'http://', 'npm_', 'ghp_', 'Bearer ', 'registry.npmjs.org/']
    assert.ok(fires.length > 0, '至少要有行可查')
    for (const row of fires) {
      const text = JSON.stringify(row.fields)
      for (const needle of forbidden) {
        assert.equal(text.includes(needle), false, `${row.event} 里出现了 ${needle}：${text}`)
      }
    }
  })
})
