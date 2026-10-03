/**
 * tests/batch-host.test.mjs —— 多目标批量宿主入口（#25）。
 *
 * 只测外部行为：五个批量电话的注册与回包形状、串行顺序（一家收尾才起下一家）、
 * 失败继续/停、每一步落盘与重开续跑、取消清空、跨使用范围拒绝、drain 起停。
 * 查/装传输用假件（真路径的接线由「真件 + 假读侧」那条用例覆盖），落盘走真临时目录。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createMultiHostUpdate, phoneRequestIdOf } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { batchPathsForUpdate } from '../dist/store.js'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

/** 一个真临时使用范围（落盘走真文件，读侧按需覆盖）。 */
async function tempScope() {
  const dir = await mkdtemp(join(tmpdir(), 'batch-host-'))
  return { dir, scope: { homeDir: dir, profileDir: dir } }
}

function target(key, over = {}) {
  return { key, title: '插件 ' + key, packageName: 'pkg-' + key, prefix: 'p-' + key, ...over }
}

/** 假传输：按目标给查/装结果，并记下调用轨迹（断言串行顺序用）。 */
function fakeTransport(plan = {}) {
  const calls = { check: [], install: [], trace: [] }
  const transport = {
    check: async (key) => {
      calls.check.push(key)
      calls.trace.push('check:' + key)
      const item = plan[key] ?? {}
      if (item.checkError) throw item.checkError
      return item.check ?? { kind: 'update', version: '2.0.0' }
    },
    install: async (key, spec, requestId, version) => {
      calls.install.push({ key, requestId, version })
      calls.trace.push('install:' + key)
      const item = plan[key] ?? {}
      if (item.installError) throw item.installError
      return item.install ?? { kind: 'done', restartRequired: false }
    },
  }
  return { calls, transport }
}

async function readDiskSession(dir) {
  return JSON.parse(await readFile(batchPathsForUpdate(dir, dir).file, 'utf8'))
}

function entryOf(session, key) {
  return session.entries.find((entry) => entry.key === key) ?? null
}

function phaseOf(session, key) {
  const entry = entryOf(session, key)
  return entry ? entry.phase : null
}

/** 让排好的微任务与一次 tick 的异步链落定（含真文件 I/O）。 */
async function settle() {
  await new Promise((done) => setImmediate(done))
  await new Promise((done) => setImmediate(done))
}

/** 等到条件成立（drain tick 里有真落盘，一轮事件循环等不齐）。 */
async function waitFor(check, label) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  assert.fail('等待超时：' + label)
}

describe('注册与命名', () => {
  it('五个批量电话与每个目标的三个单插件电话都注册，前缀互不相同', async () => {
    const { scope } = await tempScope()
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'self']
    const targets = keys.map((key) => target(key))
    const host = createMultiHostUpdate({ scope }, { prefix: 'life', targets, selfKey: 'self' })
    assert.deepEqual(host.phoneNames, {
      status: 'life.batchStatus',
      check: 'life.batchCheck',
      install: 'life.batchInstall',
      resume: 'life.batchResume',
      cancel: 'life.batchCancel',
    })
    const names = Object.keys(host.handlers)
    assert.equal(names.length, 5 + keys.length * 3)
    for (const name of Object.values(host.phoneNames)) assert.ok(names.includes(name), name)
    const prefixes = new Set()
    for (const one of targets) {
      prefixes.add(one.prefix)
      for (const action of ['updateStatus', 'updateCheck', 'updateInstall']) {
        assert.ok(names.includes(one.prefix + '.' + action), one.prefix + '.' + action)
      }
    }
    assert.equal(prefixes.size, keys.length, '七个前缀互不相同')
    assert.notEqual(host.handlers['p-a.updateStatus'], host.handlers['p-b.updateStatus'])
    host.dispose()
  })

  it('targets 顺序＝会话顺序，自己排最后', async () => {
    const { scope } = await tempScope()
    const host = createMultiHostUpdate(
      { scope },
      { prefix: 'life', targets: [target('self'), target('a'), target('b')], selfKey: 'self' },
    )
    assert.deepEqual(host.targets.map((one) => one.key), ['a', 'b', 'self'])
    host.dispose()
  })
})

describe('每个目标一份宿主能力，不串内存', () => {
  it('两个目标同包名也不串内存（真件 + 逐目标假读侧）', async () => {
    const { dir, scope } = await tempScope()
    const targets = [
      target('alpha', { packageName: 'same-pkg' }),
      target('beta', { packageName: 'same-pkg' }),
    ]
    const installed = (version) => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: dir,
      profileDir: dir,
      installedVersion: version,
      packageValid: true,
      sourceInstall: false,
      blockedReason: null,
      installationKey: 'key-' + version,
      eligible: true,
    })
    const host = createMultiHostUpdate(
      {
        scope,
        readerOverridesFor: (spec) => {
          const version = spec.key === 'alpha' ? '1.0.0' : '9.0.0'
          return {
            runningVersion: version,
            profileDir: dir,
            homeDir: dir,
            profileName: 'web',
            readInstalled: async () => installed(version),
            readJob: async () => null,
            writeJob: async () => {},
            tryAcquireLock: async () => true,
            releaseLock: async () => {},
            backupJob: async () => {},
            runInstall: async () => {},
            fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => '{}' }),
            now: () => 1000,
            randomId: () => 'id-1',
          }
        },
      },
      { prefix: 'life', targets },
    )
    const reply = await host.handlers['life.batchStatus']({})
    assert.equal(reply.ok, true)
    const rowOf = Object.fromEntries(reply.rows.map((row) => [row.key, row]))
    assert.equal(rowOf.alpha.snapshot.runningVersion, '1.0.0')
    assert.equal(rowOf.beta.snapshot.runningVersion, '9.0.0')
    assert.equal(rowOf.alpha.snapshot.installedVersion, '1.0.0')
    assert.equal(rowOf.beta.snapshot.installedVersion, '9.0.0')
    assert.equal(rowOf.alpha.profileName, 'web')
    host.dispose()
  })
})

describe('batchInstall：建会话、按会话顺序一家收尾才起下一家', () => {
  it('调用轨迹是「查一家、装一家」交替，自己最后；编号取账本里的幂等编号', async () => {
    const { scope } = await tempScope()
    const { calls, transport } = fakeTransport()
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: ['a', 'b', 'self'].map((key) => target(key)), selfKey: 'self' },
    )
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(calls.trace, [
      'check:a', 'install:a',
      'check:b', 'install:b',
      'check:self', 'install:self',
    ])
    assert.deepEqual(reply.session.order, ['a', 'b', 'self'])
    assert.deepEqual(reply.rows.map((row) => row.phase), ['done', 'done', 'done'])
    assert.equal(reply.progress.total, 3)
    assert.equal(reply.progress.done, 3)
    assert.equal(reply.progress.finished, true)
    assert.deepEqual(
      calls.install.map((one) => one.requestId),
      ['batch:' + reply.session.id + ':a', 'batch:' + reply.session.id + ':b', 'batch:' + reply.session.id + ':self'],
    )
    host.dispose()
  })

  it('一家失败默认继续下一家（失败也是收尾，不阻塞整轮结束）', async () => {
    const { scope } = await tempScope()
    const { calls, transport } = fakeTransport({ a: { install: { kind: 'failed', error: 'install-failed' } } })
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: ['a', 'b', 'self'].map((key) => target(key)), selfKey: 'self' },
    )
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(calls.check, ['a', 'b', 'self'])
    assert.equal(phaseOf(reply.session, 'a'), 'failed')
    assert.equal(entryOf(reply.session, 'a').error, 'install-failed')
    assert.deepEqual(reply.rows.map((row) => row.phase), ['failed', 'done', 'done'])
    assert.equal(reply.progress.failed, 1)
    assert.equal(reply.progress.finished, true)
    host.dispose()
  })

  it('stopOnFailure=true：一遇失败就停，后面那家仍是 pending', async () => {
    const { scope } = await tempScope()
    const { calls, transport } = fakeTransport({ a: { check: { kind: 'failed', error: 'check-failed' } } })
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: ['a', 'b', 'self'].map((key) => target(key)), selfKey: 'self', stopOnFailure: true },
    )
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(calls.check, ['a'])
    assert.deepEqual(calls.install, [])
    assert.equal(phaseOf(reply.session, 'a'), 'failed')
    assert.equal(phaseOf(reply.session, 'b'), 'pending')
    assert.equal(reply.progress.finished, false)
    host.dispose()
  })
})

describe('每一步落盘：断点续跑的全部依据', () => {
  it('盘上能看到中间相位：一家在装时别家还是 pending，收尾后全落定', async () => {
    const { dir, scope } = await tempScope()
    const seen = []
    const transport = {
      check: async () => {
        seen.push(await readDiskSession(dir))
        return { kind: 'update', version: '2.0.0' }
      },
      install: async (key) => {
        seen.push(await readDiskSession(dir))
        return { kind: 'done', restartRequired: key === 'self' }
      },
    }
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: ['a', 'b', 'self'].map((key) => target(key)), selfKey: 'self' },
    )
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(phaseOf(seen[0], 'a'), 'checking', '查之前先落 checking')
    assert.equal(phaseOf(seen[0], 'b'), 'pending')
    assert.equal(phaseOf(seen[1], 'a'), 'installing', '提交安装先落 installing')
    assert.equal(phaseOf(seen[1], 'b'), 'pending', '一家没收尾不起下一家')
    assert.equal(phaseOf(seen[2], 'b'), 'checking')
    assert.equal(phaseOf(seen[2], 'a'), 'done')
    const onDisk = await readDiskSession(dir)
    assert.deepEqual(onDisk.entries.map((entry) => entry.phase), ['done', 'done', 'done'])
    assert.equal(entryOf(onDisk, 'self').restartRequired, true)
    assert.deepEqual(reply.session, onDisk)
    host.dispose()
  })

  it('重开一份读同一目录：batchResume 接着走，已完成的不重装', async () => {
    const { dir, scope } = await tempScope()
    const first = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async (key) => {
            if (key === 'b') throw new Error('boom')
            return { kind: 'update', version: '2.0.0' }
          },
          install: async () => ({ kind: 'done', restartRequired: false }),
        },
      },
      { prefix: 'life', targets: ['a', 'b', 'self'].map((key) => target(key)), selfKey: 'self' },
    )
    const broke = await first.handlers['life.batchInstall']({})
    assert.equal(broke.ok, false)
    assert.equal(broke.error, 'check-failed')
    const onDisk = await readDiskSession(dir)
    assert.equal(phaseOf(onDisk, 'a'), 'done', '中断前已收尾的那家留在盘上')
    assert.equal(phaseOf(onDisk, 'b'), 'checking', '中断在查里的那家留在盘上')
    const doneRequestId = entryOf(onDisk, 'a').requestId
    first.dispose()

    const calls = []
    const second = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async (key) => {
            calls.push('check:' + key)
            return { kind: 'update', version: '2.0.0' }
          },
          install: async (key) => {
            calls.push('install:' + key)
            return { kind: 'done', restartRequired: false }
          },
        },
      },
      { prefix: 'life', targets: ['a', 'b', 'self'].map((key) => target(key)), selfKey: 'self' },
    )
    const resumed = await second.handlers['life.batchResume']({})
    assert.equal(resumed.ok, true)
    assert.deepEqual(calls, ['check:b', 'install:b', 'check:self', 'install:self'], '已完成的不再查、不再装')
    assert.equal(phaseOf(resumed.session, 'a'), 'done')
    assert.equal(entryOf(resumed.session, 'a').requestId, doneRequestId, '同一会话同一目标编号恒定')
    assert.equal(resumed.progress.finished, true)
    second.dispose()
  })
})

describe('batchCancel 与坏账本', () => {
  it('batchCancel 清空盘上会话，回空会话', async () => {
    const { dir, scope } = await tempScope()
    const { transport } = fakeTransport()
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: ['a', 'b'].map((key) => target(key)) },
    )
    const installed = await host.handlers['life.batchInstall']({})
    assert.equal(installed.progress.finished, true)
    const cancelled = await host.handlers['life.batchCancel']({})
    assert.equal(cancelled.ok, true)
    assert.deepEqual(cancelled.session.entries, [])
    assert.equal(cancelled.progress.total, 2, '还没有账本时进度按清单给全待办')
    assert.equal(cancelled.progress.pending, 2)
    assert.deepEqual((await readDiskSession(dir)).entries, [], '盘上也是空会话')
    const again = await host.handlers['life.batchStatus']({})
    assert.deepEqual(again.session.entries, [])
    assert.deepEqual(again.rows.map((row) => row.phase), ['pending', 'pending'])
    host.dispose()
  })

  it('盘上账本坏掉：回空会话，不抛错', async () => {
    const { dir, scope } = await tempScope()
    const paths = batchPathsForUpdate(dir, dir)
    await mkdir(dirname(paths.file), { recursive: true })
    await writeFile(paths.file, '{ 这不是 JSON', 'utf8')
    const { transport } = fakeTransport()
    const host = createMultiHostUpdate({ scope, transport }, { prefix: 'life', targets: [target('a')] })
    const reply = await host.handlers['life.batchStatus']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.session.entries, [])
    assert.equal(reply.rows.length, 1)
    host.dispose()
  })
})

describe('跨使用范围如实拒绝', () => {
  it('目标清单混进别的使用范围：五个电话都回错，且不写任何一家的账本', async () => {
    const one = await tempScope()
    const other = await tempScope()
    const targets = [target('a'), target('b', { profileDir: other.dir })]
    const host = createMultiHostUpdate({ scope: one.scope }, { prefix: 'life', targets })
    for (const action of ['batchStatus', 'batchCheck', 'batchInstall', 'batchResume', 'batchCancel']) {
      const reply = await host.handlers['life.' + action]({})
      assert.equal(reply.ok, false, action)
      assert.equal(reply.error, 'cross-scope', action)
      assert.equal(reply.errorKind, 'cross-scope', action)
    }
    await assert.rejects(readFile(batchPathsForUpdate(one.dir, one.dir).file))
    await assert.rejects(readFile(batchPathsForUpdate(other.dir, other.dir).file))
    host.dispose()
  })
})

describe('行内只推一家与重试', () => {
  it('batchInstall { keys:[key] } 只推这一家，别家不动；空数组＝空转', async () => {
    const { scope } = await tempScope()
    const { calls, transport } = fakeTransport()
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: ['a', 'b', 'self'].map((key) => target(key)), selfKey: 'self' },
    )
    const reply = await host.handlers['life.batchInstall']({ keys: ['b'] })
    assert.equal(reply.ok, true)
    assert.deepEqual(calls.trace, ['check:b', 'install:b'])
    assert.deepEqual(reply.session.order, ['a', 'b', 'self'], '账本顺序仍是全清单（自己最后）')
    assert.equal(phaseOf(reply.session, 'a'), 'pending')
    assert.equal(phaseOf(reply.session, 'b'), 'done')
    assert.equal(phaseOf(reply.session, 'self'), 'pending')
    assert.equal(reply.progress.finished, false)
    const empty = await host.handlers['life.batchInstall']({ keys: [] })
    assert.equal(empty.ok, true)
    assert.deepEqual(calls.trace, ['check:b', 'install:b'], '空数组不推任何一家')
    const unknown = await host.handlers['life.batchInstall']({ keys: ['nope'] })
    assert.equal(unknown.ok, true)
    assert.deepEqual(calls.trace, ['check:b', 'install:b'])
    host.dispose()
  })

  it('failed 行带 keys 重推：先复位成 pending 再真的重装', async () => {
    const { scope } = await tempScope()
    let failOnce = true
    const calls = []
    const transport = {
      check: async (key) => {
        calls.push('check:' + key)
        return { kind: 'update', version: '2.0.0' }
      },
      install: async (key) => {
        calls.push('install:' + key)
        if (key === 'a' && failOnce) {
          failOnce = false
          return { kind: 'failed', error: 'install-failed' }
        }
        return { kind: 'done', restartRequired: false }
      },
    }
    const host = createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: ['a', 'b'].map((key) => target(key)) },
    )
    const first = await host.handlers['life.batchInstall']({})
    assert.equal(phaseOf(first.session, 'a'), 'failed')
    assert.equal(phaseOf(first.session, 'b'), 'done')
    calls.length = 0
    const retry = await host.handlers['life.batchInstall']({ keys: ['a'] })
    assert.equal(retry.ok, true)
    assert.deepEqual(calls, ['check:a', 'install:a'])
    assert.equal(phaseOf(retry.session, 'a'), 'done')
    assert.equal(phaseOf(retry.session, 'b'), 'done', '别家的 done 不被抹掉')
    host.dispose()
  })
})

describe('drain：默认关，显式开了也要能停干净', () => {
  it('默认关：一个定时器都不起', async () => {
    const { scope } = await tempScope()
    const scheduled = []
    const timers = {
      setTimeout: (fn, ms) => {
        scheduled.push({ fn, ms })
        return scheduled.length
      },
      clearTimeout: () => {},
    }
    const { calls, transport } = fakeTransport()
    const host = createMultiHostUpdate(
      { scope, transport, timers },
      { prefix: 'life', targets: ['a', 'b'].map((key) => target(key)) },
    )
    await host.handlers['life.batchInstall']({ keys: ['a'] })
    assert.deepEqual(scheduled, [])
    assert.deepEqual(calls.trace, ['check:a', 'install:a'])
    host.dispose()
  })

  it('drain:true 才起定时器：一次 tick 推一步，dispose 清掉且不再推进', async () => {
    const { scope } = await tempScope()
    const scheduled = []
    const cleared = []
    const timers = {
      setTimeout: (fn, ms) => {
        const handle = { fn, ms }
        scheduled.push(handle)
        return handle
      },
      clearTimeout: (handle) => {
        cleared.push(handle)
      },
    }
    const { calls, transport } = fakeTransport()
    const host = createMultiHostUpdate(
      { scope, transport, timers },
      { prefix: 'life', targets: ['a', 'b'].map((key) => target(key)), drain: true, drainIntervalMs: 1000 },
    )
    assert.equal(scheduled.length, 1, '开了 drain 就排一次')
    assert.equal(scheduled[0].ms, 1000)
    await host.handlers['life.batchInstall']({ keys: ['a'] })
    calls.trace.length = 0

    scheduled[0].fn()
    await waitFor(() => scheduled.length === 2, '第一次 tick 收尾并重排')
    assert.deepEqual(calls.trace, ['check:b'], 'maxSteps:1：一次 tick 只做一次传输调用')

    scheduled[1].fn()
    await waitFor(() => scheduled.length === 3, '第二次 tick 收尾并重排')
    assert.deepEqual(calls.trace, ['check:b', 'install:b'])
    const pendingTimer = scheduled[scheduled.length - 1]
    assert.ok(pendingTimer, '还有下一次在等')

    host.dispose()
    assert.ok(cleared.includes(pendingTimer), 'dispose 清掉未落的定时器')
    calls.trace.length = 0
    pendingTimer.fn()
    await settle()
    assert.deepEqual(calls.trace, [], 'dispose 后陈旧回调不再推进')
    assert.equal(scheduled.length, 3, 'dispose 后不再排新的')
  })
})

describe('rows 新增 pluginId 与 diag（只增不改）', () => {
  it('每行都带 pluginId：显式的用显式，缺省的按「批量前缀-键」', async () => {
    const { scope } = await tempScope()
    const { transport } = fakeTransport()
    const targets = [target('a'), target('b', { pluginId: 'custom-b' })]
    const host = createMultiHostUpdate({ scope, transport }, { prefix: 'life', targets })
    const reply = await host.handlers['life.batchStatus']({})
    assert.equal(reply.ok, true)
    const rowOf = Object.fromEntries(reply.rows.map((row) => [row.key, row]))
    assert.equal(rowOf.a.pluginId, 'life-a')
    assert.equal(rowOf.b.pluginId, 'custom-b')
    assert.deepEqual(
      Object.keys(rowOf.a).sort(),
      [
        'diag', 'error', 'key', 'manual', 'phase', 'phoneNames', 'pluginId',
        'profileName', 'queue', 'restartRequired', 'snapshot', 'targetVersion', 'title',
      ],
      '既有字段一个没动，只加了 pluginId 与 diag',
    )
    host.dispose()
  })

  it('某一家 status 回包带 diag：该行与之一致，别家为 null', async () => {
    const { dir, scope } = await tempScope()
    const goodOverrides = {
      runningVersion: '1.0.0',
      profileDir: dir,
      homeDir: dir,
      profileName: 'web',
      readInstalled: async () => ({
        profileName: 'web',
        environmentKind: 'cli',
        homeDir: dir,
        profileDir: dir,
        installedVersion: '1.0.0',
        packageValid: true,
        sourceInstall: false,
        blockedReason: null,
        installationKey: 'key-1',
        eligible: true,
      }),
      readJob: async () => null,
      writeJob: async () => {},
    }
    const host = createMultiHostUpdate(
      { scope, readerOverridesFor: (spec) => (spec.key === 'bad' ? undefined : goodOverrides) },
      { prefix: 'life', targets: [target('bad'), target('good')] },
    )
    const args = { includeEnv: true, includeQueue: true }
    const phone = await host.handlers['p-bad.updateStatus'](args)
    assert.equal(phone.ok, false)
    assert.ok(phone.diag, '真件失败回包自带 diag（#21）')
    const reply = await host.handlers['life.batchStatus']({})
    const rowOf = Object.fromEntries(reply.rows.map((row) => [row.key, row]))
    assert.ok(rowOf.bad.diag, '失败那家的 diag 带出来了')
    assert.equal(rowOf.good.diag, null, '成功那家为 null')
    const strip = (diag) => {
      const copy = { ...diag }
      delete copy.latencyMs
      return copy
    }
    assert.deepEqual(strip(rowOf.bad.diag), strip(phone.diag), '与同一失败路径的回包一致（只差耗时）')
    host.dispose()
  })

  it('一家失败后（error 有值）仍带 diag；成功那家为 null', async () => {
    const { dir, scope } = await tempScope()
    const registry = 'https://registry.npmjs.org/'
    const targetName = 'pkg-good'
    let installed = '1.0.0'
    let job = null
    let clock = 1000000
    const fetchImpl = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: targetName,
          version: '2.0.0',
          engines: { node: '>=22' },
          dist: {
            tarball: registry + targetName + '/-/' + targetName + '-2.0.0.tgz',
            integrity: 'sha512-' + 'A'.repeat(86) + '==',
          },
        }),
    })
    const goodOverrides = {
      runningVersion: '1.0.0',
      profileDir: dir,
      homeDir: dir,
      profileName: 'web',
      environmentKind: 'cli',
      nodeVersion: '22.0.0',
      targetPackageName: targetName,
      fetchImpl,
      now: () => (clock += 10),
      randomId: (() => {
        let n = 0
        return () => 'id-' + (n += 1)
      })(),
      readInstalled: async () => ({
        profileName: 'web',
        environmentKind: 'cli',
        homeDir: dir,
        profileDir: dir,
        installedVersion: installed,
        packageValid: true,
        sourceInstall: false,
        blockedReason: null,
        installationKey: 'key-1',
        eligible: true,
      }),
      readJob: async () => job,
      writeJob: async (value) => {
        job = value
      },
      tryAcquireLock: async () => true,
      releaseLock: async () => {},
      backupJob: async () => {},
      runInstall: async () => {
        installed = '2.0.0'
      },
    }
    const host = createMultiHostUpdate(
      { scope, installPollMs: 5, readerOverridesFor: (spec) => (spec.key === 'bad' ? undefined : goodOverrides) },
      { prefix: 'life', targets: [target('bad'), target('good')] },
    )
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const rowOf = Object.fromEntries(reply.rows.map((row) => [row.key, row]))
    assert.equal(rowOf.bad.phase, 'failed')
    assert.equal(rowOf.bad.error, 'unknown-profile')
    assert.ok(rowOf.bad.diag, '失败那家仍能带出 diag')
    assert.equal(rowOf.good.phase, 'done')
    assert.equal(rowOf.good.diag, null, '成功那家为 null')
    host.dispose()
  })
})

describe('真路径：单插件电话 -> 驱动器', () => {
  it('一家真装：查电话拿凭证、装电话后台收尾、账本记 done + restartRequired', async () => {
    const { dir, scope } = await tempScope()
    const targetName = 'pkg-alpha'
    const registry = 'https://registry.npmjs.org/'
    let installed = '1.0.0'
    let job = null
    let locked = null
    let clock = 1000000
    const fetchImpl = async (url) => {
      assert.equal(url, registry + encodeURIComponent(targetName) + '/latest')
      return {
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            name: targetName,
            version: '2.0.0',
            engines: { node: '>=22' },
            dist: {
              tarball: registry + targetName + '/-/' + targetName + '-2.0.0.tgz',
              integrity: 'sha512-' + 'A'.repeat(86) + '==',
            },
          }),
      }
    }
    const host = createMultiHostUpdate(
      {
        scope,
        installPollMs: 5,
        readerOverrides: {
          runningVersion: '1.0.0',
          profileDir: dir,
          homeDir: dir,
          profileName: 'web',
          environmentKind: 'cli',
          nodeVersion: '22.0.0',
          targetPackageName: targetName,
          fetchImpl,
          now: () => (clock += 10),
          randomId: (() => {
            let n = 0
            return () => 'id-' + (n += 1)
          })(),
          readInstalled: async () => ({
            profileName: 'web',
            environmentKind: 'cli',
            homeDir: dir,
            profileDir: dir,
            installedVersion: installed,
            packageValid: true,
            sourceInstall: false,
            blockedReason: null,
            installationKey: 'key-1',
            eligible: true,
          }),
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
          runInstall: async () => {
            installed = '2.0.0'
          },
        },
      },
      {
        prefix: 'life',
        targets: [{ key: 'alpha', title: '甲', packageName: targetName, prefix: 'p-alpha' }],
      },
    )
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'alpha'), 'done')
    assert.equal(entryOf(reply.session, 'alpha').targetVersion, '2.0.0')
    assert.equal(entryOf(reply.session, 'alpha').restartRequired, true)
    assert.equal(reply.rows[0].snapshot.latestVersion, '2.0.0')
    assert.equal(reply.rows[0].snapshot.installedVersion, '2.0.0')
    host.dispose()
  })
})

describe('回包形状与编号换算', () => {
  it('成功回包恰好四键；失败回包只有 ok/error/errorKind', async () => {
    const { scope } = await tempScope()
    const { transport } = fakeTransport()
    const ok = await createMultiHostUpdate(
      { scope, transport },
      { prefix: 'life', targets: [target('a')] },
    ).handlers['life.batchStatus']({})
    assert.deepEqual(Object.keys(ok).sort(), ['ok', 'progress', 'rows', 'session'])
    const row = ok.rows[0]
    for (const key of ['key', 'title', 'phase', 'targetVersion', 'restartRequired', 'error', 'snapshot']) {
      assert.ok(key in row, key)
    }
    const one = await tempScope()
    const other = await tempScope()
    const bad = await createMultiHostUpdate(
      { scope: one.scope },
      { prefix: 'life', targets: [target('a'), target('b', { profileDir: other.dir })] },
    ).handlers['life.batchStatus']({})
    assert.deepEqual(Object.keys(bad).sort(), ['error', 'errorKind', 'ok'])
  })

  it('账本编号翻电话编号：恒定、形状合法、不同编号不撞', () => {
    const first = phoneRequestIdOf('batch:s1:a')
    assert.equal(first, phoneRequestIdOf('batch:s1:a'))
    assert.match(first, /^[A-Za-z0-9._~-]+$/)
    assert.ok(first.length <= 128)
    assert.notEqual(first, phoneRequestIdOf('batch:s1:b'))
    assert.notEqual(first, phoneRequestIdOf('batch:s1-a'))
    assert.equal(phoneRequestIdOf('req-1'), 'req-1')
  })

  it('算不出使用范围目录：会话退化为内存账本，推进照旧', async () => {
    const { transport } = fakeTransport()
    const host = createMultiHostUpdate({ transport }, { prefix: 'life', targets: [target('a')] })
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done')
    const status = await host.handlers['life.batchStatus']({})
    assert.equal(phaseOf(status.session, 'a'), 'done', '同一份内存账本还在')
    host.dispose()
  })
})
