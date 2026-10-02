/**
 * tests/diag-phone.test.mjs —— #21 电话侧失败证据 diag 落地（#18 契约实现）。
 *
 * 只走公开电话最高口（createHostUpdate handlers）：不直调 buildDiag / service / diag 内部，
 * 不测内部实现、计时精确值、状态机写法。断言外部行为：失败回包形状、宽容读三向矩阵、
 * 复制自包含性、动作提示一致性。假读取与假执行零件，不真联网真装。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const RELEASE_VERSION = '9.9.9'

function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length
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

function eligibleEnv(installedVersion = '1.0.0') {
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

function goodRelease(version = RELEASE_VERSION, targetName = TARGET) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        name: targetName,
        version,
        engines: { node: '>=22' },
        dist: {
          tarball: `${REGISTRY}${targetName}/-/${targetName}-${version}.tgz`,
          integrity: 'sha512-' + 'A'.repeat(86) + '==',
        },
      }),
  }
}

function makeHost({
  pluginId = 'dsh-mattpocock-skills-deck',
  prefix,
  installedVersion = '1.0.0',
  fires = [],
  fetchImpl,
  readInstalled,
  runInstall,
  backupJob,
  environmentKind = 'cli',
  runningVersion = '1.0.0',
} = {}) {
  const store = memoryStore()
  if (backupJob) store.backupJob = backupJob
  const host = createHostUpdate(
    {
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
      readerOverrides: {
        runningVersion,
        profileDir: 'C:\\fake\\profile',
        profileName: 'web',
        homeDir: 'C:\\fake\\home',
        fetchImpl: fetchImpl ?? (async () => goodRelease()),
        now: () => 1_000_000,
        randomId: (() => {
          let n = 0
          return () => `id-${(n += 1)}`
        })(),
        nodeVersion: '22.0.0',
        environmentKind,
        targetPackageName: TARGET,
        readInstalled: readInstalled ?? (async () => eligibleEnv(installedVersion)),
        ...store,
        runInstall: runInstall ?? (async () => {}),
      },
    },
    prefix === undefined ? { pluginId } : { pluginId, prefix },
  )
  return host
}

const DIAG_KEYS_16 = [
  'v',
  'stage',
  'route',
  'method',
  'httpStatus',
  'exitCode',
  'latencyMs',
  'detail',
  'targetPackageName',
  'runningVersion',
  'latestVersion',
  'environmentKind',
  'requestId',
  'checkId',
  'registryHost',
  'action',
]
const STAGES_6 = ['read-installed', 'fetch-release', 'validate-release', 'preflight', 'exec', 'verify']
const ACTIONS_4 = ['retry', 'manual', 'contact', 'restart']

function assertDiagWellFormed(diag) {
  assert.ok(diag && typeof diag === 'object' && !Array.isArray(diag), 'diag 须为对象')
  assert.equal(diag.v, 1, '对象版本 v=1 只管大门')
  assert.ok(STAGES_6.includes(diag.stage), `阶段须冻结六值之一，实际 ${diag.stage}`)
  // 路由与方法正交：各自独立缺省（预算墙可单独省 method 而留 route，见 #24 顺序）。
  if ('route' in diag) assert.equal(typeof diag.route, 'string')
  if ('method' in diag) assert.equal(typeof diag.method, 'string')
  // 16 键目录：除显式 truncated 位外，其余一律易变即面板必须忽略——此处断言绝不出现 queuePos。
  for (const k of Object.keys(diag)) {
    if (k === 'truncated') {
      assert.equal(diag.truncated, true, 'truncated 只在超墙动过手时出现，且恒为 true')
      continue
    }
    assert.ok(DIAG_KEYS_16.includes(k), `目录外键 ${k} 不该出现在电话侧 diag（queuePos 留空到队列转正）`)
  }
  assert.ok(!('queuePos' in diag), 'queuePos 留空到队列转正，本票永不产出')
  if ('action' in diag) assert.ok(ACTIONS_4.includes(diag.action), `动作须四值之一，实际 ${diag.action}`)
  if ('httpStatus' in diag) {
    assert.equal(typeof diag.httpStatus, 'number')
    assert.ok(Number.isInteger(diag.httpStatus) && diag.httpStatus >= 100 && diag.httpStatus <= 599)
  }
  if ('exitCode' in diag) assert.equal(typeof diag.exitCode, 'number')
  if ('latencyMs' in diag) assert.equal(typeof diag.latencyMs, 'number')
  if ('detail' in diag) assert.equal(typeof diag.detail, 'string')
  // 序列化 ≤1024 字节墙（含 truncated 位）。
  assert.ok(byteLength(JSON.stringify(diag)) <= 1024, `diag 序列化须在内联预算内，实际 ${byteLength(JSON.stringify(diag))}`)
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

describe('成功形状不动（成功回包永不带 diag）', () => {
  it('查状态成功无 diag，快照仍六字段', async () => {
    const fires = []
    const host = makeHost({ fires })
    const out = await host.handlers['wf.updateStatus']({})
    assert.equal(out.ok, true)
    assert.ok(!('diag' in out), '成功回包不得带 diag')
    assert.deepEqual(Object.keys(out.snapshot).sort(), ['blockedReason', 'canInstall', 'installedVersion', 'job', 'latestVersion', 'runningVersion'])
  })

  it('查新版成功无 diag，凭证形状冻结', async () => {
    const fires = []
    const host = makeHost({ fires })
    const out = await host.handlers['wf.updateCheck']({})
    assert.equal(out.ok, true)
    assert.ok(!('diag' in out))
    assert.ok(out.receipt && typeof out.receipt.checkId === 'string')
  })
})

describe('失败回包加可选 diag（16 键目录 + 脱敏构造）', () => {
  it('取数 429：fetch-release + httpStatus + retry + 已脱敏', async () => {
    const fires = []
    const host = makeHost({
      fires,
      fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'too many' }),
    })
    const out = await host.handlers['wf.updateCheck']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'check-failed')
    assert.ok(out.diag, '失败须带 diag')
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'fetch-release')
    assert.equal(out.diag.route, 'registry')
    assert.equal(out.diag.method, 'https')
    assert.equal(out.diag.httpStatus, 429)
    assert.ok(!('exitCode' in out.diag), '取数阶段不该有 exitCode')
    assert.equal(out.diag.action, 'retry')
    assert.equal(typeof out.diag.detail, 'string')
  })

  it('发行物非法：validate-release + manual，不带 httpStatus/exitCode', async () => {
    const fires = []
    const host = makeHost({
      fires,
      fetchImpl: async () => goodRelease('bad-version'),
    })
    const out = await host.handlers['wf.updateCheck']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'invalid-release')
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'validate-release')
    assert.equal(out.diag.route, 'registry')
    assert.equal(out.diag.method, 'https')
    assert.ok(!('httpStatus' in out.diag))
    assert.ok(!('exitCode' in out.diag))
    assert.equal(out.diag.action, 'manual')
  })

  it('读已装失败：read-installed + disk/fs，不带状态码与退出码', async () => {
    const fires = []
    const host = makeHost({
      fires,
      readInstalled: async () => {
        throw Object.assign(new Error('weird disk'), { code: 'EIO' })
      },
    })
    const out = await host.handlers['wf.updateStatus']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'check-failed')
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'read-installed')
    assert.equal(out.diag.route, 'disk')
    assert.equal(out.diag.method, 'fs')
    assert.ok(!('httpStatus' in out.diag))
    assert.ok(!('exitCode' in out.diag))
  })

  it('装前复核：check-expired + preflight + manual', async () => {
    const fires = []
    const host = makeHost({ fires })
    const out = await host.handlers['wf.updateInstall']({ checkId: 'wrong', requestId: 'req-1' })
    assert.equal(out.ok, false)
    assert.equal(out.error, 'check-expired')
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'preflight')
    assert.ok(!('httpStatus' in out.diag))
    assert.ok(!('exitCode' in out.diag))
    assert.equal(out.diag.action, 'manual')
  })

  it('执行失败：install-failed + exec + exitCode + contact，路由方法正交', async () => {
    // 诚实路径：安装电话经有效凭证走到执行（备份抛 install-failed），阶段为 exec。
    const fires = []
    const host = makeHost({
      fires,
      environmentKind: 'desktop-manager',
      backupJob: async () => {
        throw Object.assign(new Error('manager failed'), {
          code: 'install-failed',
          detail: 'operation-error: 打包阶段没产出可安装产物',
          exitCode: 1,
        })
      },
    })
    const check = await host.handlers['wf.updateCheck']({})
    assert.equal(check.ok, true)
    const out = await host.handlers['wf.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-9' })
    assert.equal(out.ok, false)
    assert.equal(out.error, 'install-failed')
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'exec')
    assert.equal(out.diag.route, 'desktop-manager')
    assert.equal(out.diag.method, 'phone')
    assert.equal(out.diag.exitCode, 1)
    assert.ok(!('httpStatus' in out.diag), '执行阶段不该有 httpStatus')
    assert.equal(out.diag.action, 'contact')
  })

  it('对抗：状态电话永为 read-installed（install-failed 在此亦为读失败，不谎称 exec）', async () => {
    const fires = []
    const host = makeHost({
      fires,
      environmentKind: 'desktop-manager',
      readInstalled: async () => {
        throw Object.assign(new Error('manager failed'), {
          code: 'install-failed',
          detail: 'operation-error: 读任务落盘失败',
          exitCode: 1,
        })
      },
    })
    const out = await host.handlers['wf.updateStatus']({})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'install-failed')
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'read-installed', '状态电话从不执行安装，谎称 exec 即误导')
    assert.equal(out.diag.route, 'disk')
    assert.ok(!('exitCode' in out.diag), '读阶段按表禁 exitCode（错配的退出码不进载荷）')
  })

  it('对抗：查新版环境失败归 read-installed（非 preflight）', async () => {
    const fires = []
    const host2 = makeHost({
      fires,
      readInstalled: async () => {
        throw Object.assign(new Error('unknown-profile'), { code: 'unknown-profile' })
      },
    })
    const out = await host2.handlers['wf.updateCheck']({})
    assert.equal(out.ok, false)
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'read-installed', '查新版无装前复核段，环境失败只能是读已装')
    assert.equal(out.diag.route, 'disk')
  })

  it('对抗：装前复核非忙走 disk（check-expired 与队列无关）', async () => {
    const fires = []
    const host = makeHost({ fires })
    const out = await host.handlers['wf.updateInstall']({ checkId: 'wrong', requestId: 'req-1' })
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'preflight')
    assert.equal(out.diag.route, 'disk', '凭证过期与队列无关，走 queue 即误导')
    assert.equal(out.diag.method, 'fs')
  })

  it('对抗：exec 未知宿主种类时省路由方法（不猜 cli-process）', async () => {
    const { createHostUpdate: create } = await import('../dist/host.js')
    const store = memoryStore()
    const host = create(
      {
        readerOverrides: {
          runningVersion: '1.0.0',
          profileDir: 'C:\\fake\\profile',
          profileName: 'web',
          homeDir: 'C:\\fake\\home',
          fetchImpl: async () => goodRelease(),
          now: () => 1_000_000,
          randomId: (() => {
            let n = 0
            return () => `id-${(n += 1)}`
          })(),
          nodeVersion: '22.0.0',
          // 故意不传 environmentKind：生产默认路径未知即省略。
          targetPackageName: TARGET,
          readInstalled: async () => eligibleEnv(),
          ...store,
          runInstall: async () => {},
          backupJob: async () => {
            throw Object.assign(new Error('x'), { code: 'install-failed', detail: '安装失败' })
          },
        },
      },
      { pluginId: 'dsh-mattpocock-skills-deck' },
    )
    const check = await host.handlers['wf.updateCheck']({})
    const out = await host.handlers['wf.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-77' })
    assert.equal(out.error, 'install-failed')
    assertDiagWellFormed(out.diag)
    assert.equal(out.diag.stage, 'exec')
    assert.ok(!('route' in out.diag) && !('method' in out.diag), '未知宿主种类时路由方法同省，不猜')
  })

  it('对抗：可疑版本与包名不进载荷（宁可省略）', async () => {
    const fires = []
    const host = makeHost({ fires, runningVersion: 'npm_abc123XYZ456token789' })
    const out = await host.handlers['wf.updateInstall']({ checkId: 'wrong', requestId: 'req-1' })
    assertDiagWellFormed(out.diag)
    assert.ok(!('runningVersion' in out.diag), '令牌形运行版本须省略')
    assert.ok(!JSON.stringify(out).includes('npm_abc123XYZ456token789'))
  })
})

describe('宽容读三向矩阵（只走电话口）', () => {
  it('旧面板×新载荷：剥掉 diag 后与旧形状逐字一致', async () => {
    const fires = []
    const host = makeHost({
      fires,
      fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'x' }),
    })
    const out = await host.handlers['wf.updateCheck']({})
    assert.equal(out.ok, false)
    const { diag, ...stripped } = out
    assert.ok(diag, '新载荷须带 diag 才有得剥')
    assert.deepEqual(stripped, { ok: false, error: out.error, errorKind: out.errorKind })
    assert.deepEqual(Object.keys(stripped).sort(), ['error', 'errorKind', 'ok'])
  })

  it('新面板×旧载荷：无 diag 仍为正常缺省，分支只认稳定码', async () => {
    const fires = []
    const host = makeHost({ fires })
    const out = await host.handlers['wf.updateInstall']({ checkId: 'wrong', requestId: 'req-1' })
    assert.equal(out.ok, false)
    // 旧载荷形态：删掉 diag 后仍能按码分支，不写 null 三态。
    const oldPayload = { ok: out.ok, error: out.error, errorKind: out.errorKind }
    assert.equal(oldPayload.error, 'check-expired')
    assert.ok(!('diag' in oldPayload))
    // 新载荷 dial：同一码下分支一致（diag 只多一句，不改分支）。
    assert.equal(out.error, oldPayload.error)
  })

  it('脏载荷×新面板：错类型入参永不抛，失败仍有码', async () => {
    const fires = []
    const host = makeHost({ fires })
    const dirties = [
      { checkId: 123, requestId: { evil: 1 } },
      { checkId: null, requestId: ['req-1'] },
      { checkId: 'wrong', requestId: 42, includeQueue: 'yes' },
    ]
    for (const args of dirties) {
      const out = await host.handlers['wf.updateInstall'](args)
      assert.equal(out.ok, false)
      assert.equal(typeof out.error, 'string')
      assert.equal(typeof out.errorKind, 'string')
      if ('diag' in out) assertDiagWellFormed(out.diag)
    }
  })
})

describe('脱敏构造属性（经电话口，载荷负向断言）', () => {
  it('宿主原话里的路径与令牌不进 diag.detail，全文无秘密形态', async () => {
    const fires = []
    const host = makeHost({
      fires,
      environmentKind: 'desktop-manager',
      readInstalled: async () => {
        throw Object.assign(new Error('x'), {
          code: 'install-failed',
          detail: "ENOENT '/tmp/secret/data.json' token=abc123SECRETvalue mail user@example.com",
          exitCode: 1,
        })
      },
    })
    const out = await host.handlers['wf.updateStatus']({})
    assert.equal(out.ok, false)
    assertDiagWellFormed(out.diag)
    const text = JSON.stringify(out)
    assert.ok(!text.includes('/tmp'), '绝对路径不得进载荷')
    assert.ok(!text.includes('abc123SECRETvalue'), '密码值不得进载荷')
    assert.ok(!text.includes('user@example.com'), '邮箱不得进载荷')
  })

  it('秘密形状的 requestId 按省略处理，不原样进载荷', async () => {
    const fires = []
    const host = makeHost({ fires })
    const out = await host.handlers['wf.updateInstall']({ checkId: 'wrong', requestId: '/tmp/evil' })
    assert.equal(out.ok, false)
    assert.equal(out.error, 'check-expired')
    if (out.diag) {
      assertDiagWellFormed(out.diag)
      assert.ok(!('requestId' in out.diag), '秘密形状编号须省略，不进诊断块')
      assert.ok(!JSON.stringify(out).includes('/tmp/evil'))
    }
  })
})

describe('序列化墙与动作一致性', () => {
  it('超长中文 detail 仍压进 1024 字节墙', async () => {
    const fires = []
    const host = makeHost({
      fires,
      environmentKind: 'desktop-manager',
      readInstalled: async () => {
        throw Object.assign(new Error('x'), {
          code: 'install-failed',
          detail: '中'.repeat(400),
          exitCode: 1,
        })
      },
    })
    const out = await host.handlers['wf.updateStatus']({})
    assert.equal(out.ok, false)
    assertDiagWellFormed(out.diag)
    assert.ok(byteLength(JSON.stringify(out.diag)) <= 1024)
  })

  it('动作提示与码一致：fetch→retry，非法→manual，忙→retry', async () => {
    {
      const host = makeHost({
        fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'e' }),
      })
      const out = await host.handlers['wf.updateCheck']({})
      assert.equal(out.diag.action, 'retry')
    }
    __resetSharedUpdateReaderForTests()
    {
      const host = makeHost({ fetchImpl: async () => goodRelease('bad') })
      const out = await host.handlers['wf.updateCheck']({})
      assert.equal(out.diag.action, 'manual')
    }
  })
})
