/**
 * tests/install-fail.test.mjs —— 安装失败原因链（issue #207 / 审查 S1-1）。
 *
 * 验收（issue #207）：
 *  1) 一次安装失败恰好一条常驻 warn `update.install.fail`，字段齐全（stage/reason/hostCode/
 *     check/exitCode/observedVersion/pendingRestart/intentHash）；十种现场可区分：超时、崩溃、
 *     非零退出、起进程失败、终止失败、装后版本不符、装后未登记、装后环境阻拦、空更新、闸门拒绝；
 *     exec/verify 既有事件形状不动；同一意图（intentHash）只记一条原因、可跨阶段聚合；
 *     无法归类时 reason=unknown 且照记。
 *  2) updateStatus 回包 diag 带 intentHash（面板复制诊断后可按哈希聚合；diag 原有键不动）。
 *  3) 负向断言：reason/hostCode 只出现稳定码与枚举，行里不出现路径、URL、宿主原话。
 *
 * 测试口径：只经公开件（createUpdateCore 的 log 端口、createUpdateExecutor 抛错的失败事实、
 * 随包事件清单），不深引内部实现。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createUpdateCore } from '../dist/core/service.js'
import { createUpdateExecutor } from '../dist/core/executor.js'
import { failedJobDiagOf } from '../dist/host.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const RELEASE_VERSION = '2.0.0'
const INTEGRITY = 'sha512-' + 'C'.repeat(86) + '=='

/** 独立口径的 djb2→8 位十六进制（与实现同算法但各写一份，避免自证）。 */
function expectedHash8(value) {
  let h = 5381
  const text = String(value ?? '')
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return ('0000000' + h.toString(16)).slice(-8)
}

function releaseBody() {
  return JSON.stringify({
    name: TARGET,
    version: RELEASE_VERSION,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${RELEASE_VERSION}.tgz`, integrity: INTEGRITY },
  })
}

function fakeFetch() {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(TARGET)}/latest`)
    return { ok: true, headers: { get: () => null }, text: async () => releaseBody() }
  }
}

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
    peek: () => job,
  }
}

/**
 * 可控现场：安装结束（resolve 或 reject）的瞬间改写环境事实，模拟真机装完后的磁盘/在册/阻拦。
 * `afterInstall` 收到 targetVersion，返回 {installedVersion?, registered?, blockedReason?}。
 */
function makeService({ runInstall } = {}) {
  const rows = []
  const store = memoryJobStore()
  const refs = { installedVersion: '1.0.0', registered: true, blockedReason: null }
  let hook = null
  const ports = {
    readRunningVersion: () => '1.0.0',
    readInstalled: async () => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: null,
      profileDir: null,
      installed: refs.installedVersion !== null,
      installedVersion: refs.installedVersion,
      packageValid: true,
      sourceInstall: false,
      blockedReason: refs.blockedReason,
      registered: refs.registered,
      installationKey: 'key-1',
      eligible: true,
    }),
    fetchImpl: fakeFetch(),
    now: () => 1_000_000,
    randomId: (() => {
      let n = 0
      return () => `id-${(n += 1)}`
    })(),
    nodeVersion: '22.0.0',
    readJob: store.readJob,
    writeJob: store.writeJob,
    tryAcquireLock: store.tryAcquireLock,
    releaseLock: store.releaseLock,
    backupJob: store.backupJob,
    emitLog: (level, event, fields, opts) => {
      rows.push({ level, event, fields, ...(opts ?? {}) })
    },
    runInstall: async (args) => {
      if (hook) await hook(args)
    },
  }
  const core = createUpdateCore(ports)
  const checkAndInstall = async (requestId, mutateAfter) => {
    hook = async () => {
      if (typeof mutateAfter === 'function') mutateAfter(refs)
    }
    const checked = await core.check()
    assert.equal(checked.snapshot.canInstall, true)
    return core.install({ checkId: checked.receipt.checkId, requestId, from: 'panel' })
  }
  return { core, rows, refs, checkAndInstall, setRunInstall: (fn) => (ports.runInstall = fn) }
}

const failRows = (rows) => rows.filter((r) => r.event === 'update.install.fail')
const requestRows = (rows) => rows.filter((r) => r.event === 'update.install.request')

async function waitFor(pred, timeoutMs = 2000) {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('等待后台安装落定超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function fullFields(overrides) {
  return {
    stage: 'gate',
    reason: 'unknown',
    code: 'install-failed',
    hostCodeHash: 'none',
    check: 'none',
    exitCode: null,
    observedVersion: null,
    intentHash: '',
    ...overrides,
  }
}

describe('#207 十种失败现场：一次意图恰好一条 update.install.fail', () => {
  it('超时：exec 阶段 reason=timeout（执行器/适配器分类原样落行）', async () => {
    const svc = makeService()
    svc.setRunInstall(async () => {
      throw Object.assign(new Error('安装超时'), {
        code: 'install-failed',
        installFail: { stage: 'exec', reason: 'timeout', code: 'install-failed', hostCode: 'none', check: 'none', exitCode: null },
      })
    })
    await svc.checkAndInstall('req-timeout')
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    const fails = failRows(svc.rows)
    assert.equal(fails.length, 1)
    assert.equal(fails[0].level, 'warn')
    assert.deepEqual(fails[0].fields, fullFields({ stage: 'exec', reason: 'timeout', intentHash: expectedHash8('req-timeout') }))
    // 同一意图的请求行与失败行用同一个哈希可聚合。
    assert.equal(requestRows(svc.rows).length, 1)
    assert.equal(requestRows(svc.rows)[0].fields.intentHash, expectedHash8('req-timeout'))
  })

  it('崩溃：exec 阶段 reason=crashed', async () => {
    const svc = makeService()
    svc.setRunInstall(async () => {
      throw Object.assign(new Error('装载器挂了'), {
        code: 'install-failed',
        installFail: { stage: 'exec', reason: 'crashed', code: 'install-failed', hostCode: 'none', check: 'none', exitCode: null },
      })
    })
    await svc.checkAndInstall('req-crash')
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    assert.deepEqual(failRows(svc.rows)[0].fields, fullFields({ stage: 'exec', reason: 'crashed', intentHash: expectedHash8('req-crash') }))
  })

  it('非零退出：exec 阶段 reason=nonzero-exit 且带退出码', async () => {
    const svc = makeService()
    svc.setRunInstall(async () => {
      throw Object.assign(new Error('pnpm 退出 1'), {
        code: 'install-failed',
        exitCode: 1,
        installFail: { stage: 'exec', reason: 'nonzero-exit', code: 'install-failed', hostCode: 'none', check: 'none', exitCode: 1 },
      })
    })
    await svc.checkAndInstall('req-nonzero')
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    assert.deepEqual(failRows(svc.rows)[0].fields, fullFields({ stage: 'exec', reason: 'nonzero-exit', exitCode: 1, intentHash: expectedHash8('req-nonzero') }))
  })

  it('起进程失败：exec 阶段 reason=spawn-failed 且没有退出码', async () => {
    const svc = makeService()
    svc.setRunInstall(async () => {
      throw Object.assign(new Error('起不来'), {
        code: 'install-failed',
        installFail: { stage: 'exec', reason: 'spawn-failed', code: 'install-failed', hostCode: 'none', check: 'none', exitCode: null },
      })
    })
    await svc.checkAndInstall('req-spawn')
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    assert.deepEqual(failRows(svc.rows)[0].fields, fullFields({ stage: 'exec', reason: 'spawn-failed', intentHash: expectedHash8('req-spawn') }))
  })

  it('终止失败：exec 阶段 reason=terminate-failed', async () => {
    const svc = makeService()
    svc.setRunInstall(async () => {
      throw Object.assign(new Error('终止没发出去'), {
        code: 'install-failed',
        installFail: { stage: 'exec', reason: 'terminate-failed', code: 'install-failed', hostCode: 'none', check: 'none', exitCode: null },
      })
    })
    await svc.checkAndInstall('req-term')
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    assert.deepEqual(failRows(svc.rows)[0].fields, fullFields({ stage: 'exec', reason: 'terminate-failed', intentHash: expectedHash8('req-term') }))
  })

  it('装后版本不符：verify 阶段 reason=version-mismatch check=version observedVersion=磁盘版', async () => {
    const svc = makeService()
    await svc.checkAndInstall('req-mismatch', () => {
      // 磁盘没换：仍是 1.0.0，目标 2.0.0。
    })
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    assert.deepEqual(
      failRows(svc.rows)[0].fields,
      fullFields({
        stage: 'verify',
        reason: 'version-mismatch',
        code: 'install-failed',
        check: 'version',
        observedVersion: '1.0.0',
        intentHash: expectedHash8('req-mismatch'),
      })
    )
  })

  it('装后未登记：verify 阶段 reason=not-registered check=registered', async () => {
    const svc = makeService()
    await svc.checkAndInstall('req-unreg', (refs) => {
      refs.installedVersion = RELEASE_VERSION
      refs.registered = false
    })
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    assert.deepEqual(
      failRows(svc.rows)[0].fields,
      fullFields({
        stage: 'verify',
        reason: 'not-registered',
        code: 'install-failed',
        check: 'registered',
        observedVersion: RELEASE_VERSION,
        intentHash: expectedHash8('req-unreg'),
      })
    )
  })

  it('装后环境阻拦：verify 阶段 reason=env-blocked check=env（code 是阻塞码）', async () => {
    const svc = makeService()
    await svc.checkAndInstall('req-env', (refs) => {
      refs.installedVersion = RELEASE_VERSION
      refs.blockedReason = 'recovery-required'
    })
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    assert.deepEqual(
      failRows(svc.rows)[0].fields,
      fullFields({
        stage: 'verify',
        reason: 'env-blocked',
        code: 'recovery-required',
        check: 'env',
        observedVersion: RELEASE_VERSION,
        intentHash: expectedHash8('req-env'),
      })
    )
  })

  it('空更新：gate 阶段 reason=noop（目标与已装版相同，不再动手）', async () => {
    const svc = makeService()
    const checked = await svc.core.check()
    assert.equal(checked.snapshot.canInstall, true)
    // 查完之后磁盘已经是目标版：install 的闸门应给出「没东西可装」而不是安装失败。
    svc.refs.installedVersion = RELEASE_VERSION
    await assert.rejects(svc.core.install({ checkId: checked.receipt.checkId, requestId: 'req-noop' }))
    const fails = failRows(svc.rows)
    assert.equal(fails.length, 1)
    assert.deepEqual(
      fails[0].fields,
      fullFields({ stage: 'gate', reason: 'noop', code: 'installation-changed', intentHash: expectedHash8('req-noop') })
    )
    assert.equal(requestRows(svc.rows).length, 0)
  })

  it('闸门拒绝：gate 阶段 reason=gate-refused（code 是稳定码），且没有请求行', async () => {
    const svc = makeService()
    await assert.rejects(svc.core.install({ checkId: 'no-such-check', requestId: 'req-gate' }))
    const fails = failRows(svc.rows)
    assert.equal(fails.length, 1)
    assert.deepEqual(
      fails[0].fields,
      fullFields({ stage: 'gate', reason: 'gate-refused', code: 'check-expired', intentHash: expectedHash8('req-gate') })
    )
    assert.equal(requestRows(svc.rows).length, 0)
  })

  it('凭证/编号不齐也被拒：gate 行照落（老收据重放也要有一条原因）', async () => {
    const svc = makeService()
    await assert.rejects(svc.core.install({ checkId: '', requestId: 'req-bad' }))
    const fails = failRows(svc.rows)
    assert.equal(fails.length, 1)
    assert.deepEqual(
      fails[0].fields,
      fullFields({ stage: 'gate', reason: 'gate-refused', code: 'check-expired', intentHash: expectedHash8('req-bad') })
    )
    assert.equal(requestRows(svc.rows).length, 0)
  })

  it('无法归类照记：exec 阶段 reason=unknown（不静默）', async () => {
    const svc = makeService()
    svc.setRunInstall(async () => {
      throw new Error('谁也不知道为什么')
    })
    await svc.checkAndInstall('req-unknown')
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    assert.deepEqual(failRows(svc.rows)[0].fields, fullFields({ stage: 'exec', reason: 'unknown', intentHash: expectedHash8('req-unknown') }))
  })
})

describe('#207 执行器分类：抛错里带着可上报的失败事实', () => {
  function cliExecutor(subprocess, timeoutMs = 60) {
    return createUpdateExecutor({
      profileName: 'web',
      profileDir: '/tmp/profile',
      cliEntry: '/tmp/dsh-cli.js',
      runtimeExecutable: '/usr/bin/node',
      environmentKind: 'cli',
      installTimeoutMs: timeoutMs,
      subprocess,
    })
  }

  it('起进程能力缺失 → spawn-failed', async () => {
    await assert.rejects(cliExecutor(null)({ version: RELEASE_VERSION }), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.deepEqual(error.installFail, {
        stage: 'exec',
        reason: 'spawn-failed',
        code: 'install-failed',
        hostCode: 'none',
        check: 'none',
        exitCode: null,
      })
      return true
    })
  })

  it('超时 → timeout；终止能力缺失不谎称终止发出', async () => {
    const handle = { done: new Promise(() => {}) }
    await assert.rejects(cliExecutor({ spawn: () => handle }, 30)({ version: RELEASE_VERSION }), (error) => {
      assert.equal(error.installFail.reason, 'timeout')
      assert.equal(error.installFail.exitCode, null)
      return true
    })
  })

  it('超时且终止调用失败 → terminate-failed', async () => {
    const handle = {
      done: new Promise(() => {}),
      terminate() {
        throw new Error('kill failed')
      },
    }
    await assert.rejects(cliExecutor({ spawn: () => handle }, 30)({ version: RELEASE_VERSION }), (error) => {
      assert.equal(error.installFail.reason, 'terminate-failed')
      return true
    })
  })

  it('装载器崩溃（done reject） → crashed', async () => {
    const handle = { done: Promise.reject(new Error('boom')) }
    await assert.rejects(cliExecutor({ spawn: () => handle })({ version: RELEASE_VERSION }), (error) => {
      assert.equal(error.installFail.reason, 'crashed')
      return true
    })
  })

  it('非零退出 → nonzero-exit 带真实退出码', async () => {
    const handle = { done: Promise.resolve({ exitCode: 1 }) }
    await assert.rejects(cliExecutor({ spawn: () => handle })({ version: RELEASE_VERSION }), (error) => {
      assert.deepEqual(error.installFail, {
        stage: 'exec',
        reason: 'nonzero-exit',
        code: 'install-failed',
        hostCode: 'none',
        check: 'none',
        exitCode: 1,
      })
      return true
    })
  })

  it('宿主管理器拒绝（已装包且无移除能力） → host-rejected 带宿主码', async () => {
    const executor = createUpdateExecutor({
      profileName: 'desktop',
      environmentKind: 'desktop-manager',
      pluginManager: {
        installBundle: async () => ({ application: 'failed', error: { code: 'already-installed' } }),
      },
    })
    await assert.rejects(executor({ version: RELEASE_VERSION }), (error) => {
      assert.equal(error.code, 'install-failed')
      // 宿主原始标识只在内部事实里；落行时折成 hostCodeHash（不落 already-installed 原码）。
      assert.deepEqual(error.installFail, {
        stage: 'exec',
        reason: 'host-rejected',
        code: 'install-failed',
        hostCode: 'already-installed',
        check: 'none',
        exitCode: null,
      })
      return true
    })
  })
})

describe('#207 契约与负向断言', () => {
  it('随包清单：update.install.fail 是常驻 warn、字段八个、枚举在顶层 fieldEnums；request 带 intentHash', async () => {
    const raw = JSON.parse(await readFile(new URL('../event-list.update.json', import.meta.url), 'utf8'))
    const entry = raw.events['update.install.fail']
    assert.ok(entry, '清单里应有 update.install.fail')
    assert.equal(entry.level, 'warn')
    assert.equal(entry.kind, 'resident')
    assert.deepEqual([...entry.fields].sort(), [
      'check',
      'code',
      'exitCode',
      'hostCodeHash',
      'intentHash',
      'observedVersion',
      'reason',
      'stage',
    ])
    assert.deepEqual(raw.fieldEnums['update.install.fail'].stage, ['gate', 'exec', 'verify'])
    for (const reason of [
      'host-rejected',
      'timeout',
      'crashed',
      'nonzero-exit',
      'spawn-failed',
      'terminate-failed',
      'version-mismatch',
      'not-registered',
      'env-blocked',
      'noop',
      'gate-refused',
      'unknown',
    ]) {
      assert.ok(raw.fieldEnums['update.install.fail'].reason.includes(reason), `reason 枚举缺 ${reason}`)
    }
    assert.deepEqual(raw.fieldEnums['update.install.fail'].check, ['version', 'registered', 'env', 'none'])
    // code 只收本包码面（src/shared/codes.ts 的 CORE_ERROR_CODES + internal/unsupported + none），逐值声明。
    assert.deepEqual([...raw.fieldEnums['update.install.fail'].code].sort(), [
      'channel-mismatch',
      'check-expired',
      'check-failed',
      'dev-source',
      'incompatible-dsh',
      'incompatible-node',
      'install-failed',
      'installation-changed',
      'internal',
      'invalid-installation',
      'invalid-release',
      'none',
      'pending-restart',
      'recovery-required',
      'registry-conflict',
      'source-install',
      'unknown-profile',
      'unsupported',
      'update-busy',
    ])
    assert.ok(raw.events['update.install.request'].fields.includes('intentHash'))
  })

  it('updateStatus 回包 diag：失败任务带着 intentHash（与日志行同算法，可按哈希聚合）', () => {
    const snapshot = {
      runningVersion: '1.0.0',
      job: { id: 'job-1', state: 'failed', message: 'install-failed: 装完校验没过', requestId: 'req-diag' },
    }
    const diag = failedJobDiagOf(snapshot, { targetPackageName: 'demo-plugin' })
    assert.ok(diag, '失败任务应产出 diag')
    assert.equal(diag.requestId, 'req-diag')
    assert.equal(diag.intentHash, expectedHash8('req-diag'))
    // 老任务没有 requestId 时不伪造哈希（诊断回包形状只多可选格，不猜）。
    const legacy = failedJobDiagOf({ runningVersion: '1.0.0', job: { id: 'job-2', state: 'failed', message: 'install-failed: x' } }, {})
    assert.ok(legacy)
    assert.equal(legacy.requestId, undefined)
    assert.equal(legacy.intentHash, undefined)
  })

  it('负向断言：失败行只含稳定码与枚举，不含路径、URL、宿主原话、令牌、键值与邮箱', async () => {
    const svc = makeService()
    const prose =
      'pnpm ERR! https://registry.npmjs.org/secret C:\\Users\\me\\profile token=abc123 password=hunter2 user@example.com'
    svc.setRunInstall(async () => {
      throw Object.assign(new Error(prose), { code: 'install-failed', detail: prose })
    })
    await svc.checkAndInstall('req-neg')
    await waitFor(() => failRows(svc.rows).length > 0)
    assert.equal(failRows(svc.rows).length, 1)
    const text = JSON.stringify(failRows(svc.rows)[0].fields)
    for (const needle of [
      'C:\\',
      'https://',
      'http://',
      'npmjs.org',
      'secret',
      'token=',
      'password=',
      'hunter2',
      'user@example.com',
    ]) {
      assert.equal(text.includes(needle), false, `失败行里出现了 ${needle}：${text}`)
    }
    assert.match(failRows(svc.rows)[0].fields.intentHash, /^[0-9a-f]{8}$/)
  })

  it('宿主原始标识不落行：hostCode 折成 hostCodeHash（与哈希同算法）', async () => {
    const svc = makeService()
    svc.setRunInstall(async () => {
      throw Object.assign(new Error('宿主拒绝'), {
        code: 'install-failed',
        installFail: {
          stage: 'exec',
          reason: 'host-rejected',
          code: 'install-failed',
          hostCode: 'already-installed',
          check: 'none',
          exitCode: null,
        },
      })
    })
    await svc.checkAndInstall('req-host')
    await waitFor(() => failRows(svc.rows).length > 0)
    const fields = failRows(svc.rows)[0].fields
    assert.equal(fields.hostCodeHash, expectedHash8('already-installed'))
    assert.equal(JSON.stringify(fields).includes('already-installed'), false, '宿主原始标识不许进行')
  })

  it('值域表：八格每格都落在 ADR-0006 允许的类别里（null/bool/number/hash8/semver/声明枚举）', async () => {
    const raw = JSON.parse(await readFile(new URL('../event-list.update.json', import.meta.url), 'utf8'))
    const enums = raw.fieldEnums['update.install.fail']
    const svc = makeService()
    await svc.checkAndInstall('req-classes', (refs) => {
      refs.installedVersion = RELEASE_VERSION
      refs.blockedReason = 'recovery-required'
    })
    await waitFor(() => failRows(svc.rows).length > 0)
    const fields = failRows(svc.rows)[0].fields
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || typeof value === 'boolean') continue
      if (typeof value === 'number') {
        assert.ok(Number.isInteger(value), `${key} 应是整数`)
        continue
      }
      assert.equal(typeof value, 'string', `${key} 类型越界`)
      if (key === 'intentHash') assert.match(value, /^[0-9a-f]{8}$/, `${key} 应是 hash8`)
      else if (key === 'hostCodeHash') assert.ok(value === 'none' || /^[0-9a-f]{8}$/.test(value), `${key} 应是 hash8 或 none`)
      else if (key === 'observedVersion') assert.match(value, /^\d+\.\d+\.\d+/, `${key} 应是归一 semver`)
      else {
        const allowed = enums[key]
        assert.ok(Array.isArray(allowed), `${key} 应有声明枚举`)
        assert.ok(allowed.includes(value), `${key} 值 ${value} 不在声明枚举里`)
        assert.ok(raw.events['update.install.fail'].fields.includes(key), `${key} 未在事件清单声明`)
      }
    }
  })
})
