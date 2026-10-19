/**
 * tests/issue-211-check-truth.test.mjs
 *
 * #211-A（P1-1 多源真相 / 审查 S2-1/S2-3/S2-4/S3-2）：状态真相与检查/取数日志字段。
 *
 * 覆盖（验收命令：node --test tests/issue-211-check-truth.test.mjs）：
 *   1. `update.status.changed` 是「整条真值元组」的边沿：同元组只发一次、任一格变化就发一次；
 *      未知一律显式 null（不省略、不伪造），blockedReason null→none、identity null→unknown，
 *      kind=unknown 必带 unknownCause（no-latest / running-version-unknown）。
 *   2. `update.check.done` 带 blockedReason / fallback / dataSource；通道回退时
 *      fallback=true、dataSource=npm-channel；current 未知仍按 #182 省略（不落 null）。
 *   3. `update.check.fail` 的 errorKind 细分类：timeout/network/dns/tls/http/bad-json/
 *      too-large/shape/channel/unknown；公开错误码一字不动；latencyMs 与 source 如实落。
 *   4. 更新说明取数（changelog-io）接 emitLog：tarball 取数落 `update.registry.fetch`
 *      （httpStatus/latencyMs/registryHost 三格，失败也发，预检不过不发，发射口坏了不挡取数）。
 *   5. 负向断言：新行任何一格都不含完整 URL / 路径 / 令牌原文（ADR-0006）。
 *
 * 全程不联网：registry / tarball 响应由本文件自带假件提供（tar/gzip/integrity 手搓）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createUpdateCore } from '../dist/core/service.js'
import { checkErrorKindOf, CHECK_FAIL_CAUSE_KEY } from '../dist/core/conclusion.js'
import { fetchReleaseChangelogOutcome, fetchReleaseChangelogText } from '../dist/core/changelog/io.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const LATEST = '9.9.9'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='
const registryHost = 'registry.npmjs.org'

const tarballUrl = (version) => `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`
const keysOf = (fields) => Object.keys(fields).sort()

function releaseDoc(version = LATEST, nodeRange = '>=22') {
  return {
    name: TARGET,
    version,
    engines: { node: nodeRange },
    dist: { tarball: tarballUrl(version), integrity: INTEGRITY },
  }
}

function jsonResponse(doc, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(doc),
  }
}

/** 按 URL 路由的假联网：latest 口与全量包文档口分开给。 */
function scriptedFetch({ latest, packument } = {}) {
  return async (url) => {
    if (url.endsWith('/latest')) {
      if (latest instanceof Error) throw latest
      if (typeof latest === 'function') return latest(url)
      return latest ?? jsonResponse(releaseDoc())
    }
    if (url.endsWith(`/${encodeURIComponent(TARGET)}`)) {
      if (packument instanceof Error) throw packument
      if (typeof packument === 'function') return packument(url)
      return packument ?? jsonResponse({ name: TARGET, versions: {} })
    }
    throw new Error(`unexpected url: ${url}`)
  }
}

/** 中立核心：全部副作用走注入的假件，落点收集成 rows。 */
function makeCore({ fetchImpl = scriptedFetch(), ports = {}, state: initial = {} } = {}) {
  const rows = []
  const state = {
    installedVersion: '1.0.0',
    runningVersion: '1.0.0',
    registered: undefined,
    blockedReason: null,
    installed: true,
    eligible: true,
    dshVersion: '0.5.0',
    ...initial,
  }
  let seq = 0
  const core = createUpdateCore({
    readRunningVersion: () => state.runningVersion,
    readDshVersion: () => state.dshVersion,
    readInstalled: async () => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: 'C:\\fake\\home',
      profileDir: 'C:\\fake\\profile',
      installed: state.installed,
      installedVersion: state.installedVersion,
      packageValid: true,
      sourceInstall: false,
      registered: state.registered,
      blockedReason: state.blockedReason,
      installationKey: 'fake-key',
      eligible: state.eligible,
    }),
    fetchImpl,
    now: () => 1_000_000,
    randomId: () => `id-${(seq += 1)}`,
    nodeVersion: '22.0.0',
    registryHost,
    emitLog: (level, event, fields, opts) => rows.push({ level, event, fields, opts }),
    targetPackageName: TARGET,
    registryUrl: REGISTRY,
    ...ports,
  })
  return { core, rows, state }
}

const rowsOf = (rows, event) => rows.filter((row) => row.event === event)

function stripVolatile(fields) {
  const { latencyMs, ...rest } = fields
  return rest
}

// ---------------------------------------------------------------- 1. status.changed 真值边沿

describe('#211-A update.status.changed：整条真值元组边沿，未知显式 null', () => {
  it('首次状态行把未知写成显式 null，并带 unknownCause=no-latest', async () => {
    const { core, rows } = makeCore()
    await core.status()

    const changed = rowsOf(rows, 'update.status.changed')
    assert.equal(changed.length, 1)
    const fields = changed[0].fields
    assert.deepEqual(keysOf(fields), [
      'blockedReason',
      'identity',
      'installedVersion',
      'kind',
      'latest',
      'registered',
      'runningVersion',
      'unknownCause',
    ])
    assert.deepEqual(fields, {
      kind: 'unknown',
      latest: null,
      runningVersion: '1.0.0',
      installedVersion: '1.0.0',
      registered: null,
      identity: 'unknown',
      blockedReason: 'none',
      unknownCause: 'no-latest',
    })
    assert.equal(changed[0].opts?.always, true)
    // 负向断言：整行不含 URL / 路径 / 令牌。
    const text = JSON.stringify(fields)
    for (const needle of ['https://', 'http://', 'C:\\', 'registry.npmjs.org/']) {
      assert.equal(text.includes(needle), false, `出现了 ${needle}：${text}`)
    }
  })

  it('同元组重复不发；任一格变化（kind 没变）也再发一条', async () => {
    const { core, rows, state } = makeCore()
    await core.status()
    await core.status()
    assert.equal(rowsOf(rows, 'update.status.changed').length, 1)

    // 在册事实变化：kind 仍是 unknown，但真值元组变了。
    state.registered = true
    await core.status()
    let changed = rowsOf(rows, 'update.status.changed')
    assert.equal(changed.length, 2)
    assert.equal(changed[1].fields.registered, true)
    assert.equal(changed[1].fields.kind, 'unknown')

    await core.status()
    assert.equal(rowsOf(rows, 'update.status.changed').length, 2)

    // 运行版与磁盘版分裂：kind 仍未变（体检前没有 latest），但 runningVersion 变了。
    state.runningVersion = '2.0.0'
    await core.status()
    changed = rowsOf(rows, 'update.status.changed')
    assert.equal(changed.length, 3)
    assert.equal(changed[2].fields.runningVersion, '2.0.0')
    assert.equal(changed[2].fields.installedVersion, '1.0.0')
    assert.equal(changed[2].fields.blockedReason, 'pending-restart')
    assert.equal(changed[2].fields.kind, 'unknown')
  })

  it('检查出新版：身份/最新版进同一条真相行，未知成因不再出现', async () => {
    const { core, rows } = makeCore()
    await core.status()
    await core.check('user')

    const changed = rowsOf(rows, 'update.status.changed')
    assert.equal(changed.length, 2)
    assert.deepEqual(changed[1].fields, {
      kind: 'update-available',
      latest: LATEST,
      runningVersion: '1.0.0',
      installedVersion: '1.0.0',
      registered: null,
      identity: 'update',
      blockedReason: 'none',
    })

    // 轮询不再重复落同一元组。
    await core.status()
    await core.status()
    assert.equal(rowsOf(rows, 'update.status.changed').length, 2)
  })

  it('运行版未知但已有 latest：unknownCause=running-version-unknown（不拿假版号比大小）', async () => {
    const { core, rows, state } = makeCore()
    await core.check('user')
    assert.equal(rowsOf(rows, 'update.status.changed').at(-1).fields.kind, 'update-available')

    state.runningVersion = null
    await core.status()
    const changed = rowsOf(rows, 'update.status.changed')
    const last = changed.at(-1).fields
    assert.deepEqual(last, {
      kind: 'unknown',
      latest: LATEST,
      runningVersion: null,
      installedVersion: '1.0.0',
      registered: null,
      identity: 'update',
      blockedReason: 'none',
      unknownCause: 'running-version-unknown',
    })
  })
})

// ---------------------------------------------------------------- 2. check.done 阻挡/回退/数据源

describe('#211-A update.check.done：阻挡原因、回退与数据源', () => {
  it('无回退成功检查：blockedReason=none、fallback=false、dataSource=npm-version', async () => {
    const { core, rows } = makeCore()
    await core.check('user')

    const done = rowsOf(rows, 'update.check.done')
    assert.equal(done.length, 1)
    assert.deepEqual(keysOf(done[0].fields), [
      'blockedReason',
      'channel',
      'current',
      'dataSource',
      'fallback',
      'latencyMs',
      'latest',
      'ok',
      'source',
    ])
    assert.deepEqual(stripVolatile(done[0].fields), {
      ok: true,
      current: '1.0.0',
      latest: LATEST,
      channel: 'stable',
      source: registryHost,
      blockedReason: 'none',
      fallback: false,
      dataSource: 'npm-version',
    })
    assert.equal(typeof done[0].fields.latencyMs, 'number')
    assert.ok(done[0].fields.latencyMs >= 0)
  })

  it('通道回退取数：fallback=true、dataSource=npm-channel，latest 取本通道最高发行版', async () => {
    const packument = {
      name: TARGET,
      versions: {
        '1.0.0': releaseDoc('1.0.0'),
        [LATEST]: releaseDoc(LATEST),
        '10.0.0-beta.1': releaseDoc('10.0.0-beta.1'),
      },
    }
    const { core, rows } = makeCore({
      fetchImpl: scriptedFetch({
        latest: jsonResponse(releaseDoc('10.0.0-beta.1')),
        packument: jsonResponse(packument),
      }),
    })
    await core.check('user')

    const done = rowsOf(rows, 'update.check.done')
    assert.equal(done.length, 1)
    assert.equal(done[0].fields.latest, LATEST)
    assert.equal(done[0].fields.fallback, true)
    assert.equal(done[0].fields.dataSource, 'npm-channel')
    // 两次取数都留行（latest 一口 + 全量包文档一口）。
    assert.equal(rowsOf(rows, 'update.registry.fetch').length, 2)
  })

  it('Node 不兼容进 check.done.blockedReason，且不落假成功', async () => {
    const { core, rows } = makeCore({
      fetchImpl: scriptedFetch({ latest: jsonResponse(releaseDoc(LATEST, '>=99')) }),
    })
    await core.check('user')
    const done = rowsOf(rows, 'update.check.done')
    assert.equal(done.length, 1)
    assert.equal(done[0].fields.blockedReason, 'incompatible-node')
  })

  it('current 未知时省略该格（#182 纪律不变，不落 null）', async () => {
    const { core, rows, state } = makeCore()
    state.runningVersion = null
    await core.check('user')
    const done = rowsOf(rows, 'update.check.done')
    assert.equal(done.length, 1)
    assert.deepEqual(keysOf(done[0].fields), [
      'blockedReason',
      'channel',
      'dataSource',
      'fallback',
      'latencyMs',
      'latest',
      'ok',
      'source',
    ])
  })
})

// ---------------------------------------------------------------- 3. check.fail 细分类

describe('#211-A update.check.fail：errorKind 细分类 + latencyMs/source', () => {
  function netError(code, message) {
    const cause = Object.assign(new Error(message ?? code), code ? { code } : {})
    const error = new TypeError('fetch failed')
    error.cause = cause
    return error
  }

  async function failFields(fetchImplOrPorts) {
    const options = fetchImplOrPorts && typeof fetchImplOrPorts === 'function' ? { fetchImpl: fetchImplOrPorts } : fetchImplOrPorts ?? {}
    const { core, rows } = makeCore(options)
    await assert.rejects(() => core.check('user'))
    const fail = rowsOf(rows, 'update.check.fail')
    assert.equal(fail.length, 1)
    assert.equal(fail[0].level, 'warn')
    assert.equal(typeof fail[0].fields.latencyMs, 'number')
    assert.ok(fail[0].fields.latencyMs >= 0)
    return fail[0].fields
  }

  it('timeout：超时中断', async () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    const fields = await failFields(async () => {
      throw error
    })
    assert.equal(fields.errorKind, 'timeout')
    assert.equal(fields.stage, 'fetch')
    assert.equal(fields.source, registryHost)
    assert.deepEqual(keysOf(fields), ['errorKind', 'latencyMs', 'source', 'stage'])
  })

  it('network：连接失败（ECONNREFUSED）', async () => {
    const fields = await failFields(async () => {
      throw netError('ECONNREFUSED', 'connect ECONNREFUSED')
    })
    assert.equal(fields.errorKind, 'network')
  })

  it('dns：解析失败（ENOTFOUND）', async () => {
    const fields = await failFields(async () => {
      throw netError('ENOTFOUND', 'getaddrinfo ENOTFOUND registry.npmjs.org')
    })
    assert.equal(fields.errorKind, 'dns')
  })

  it('tls：证书失败（CERT_HAS_EXPIRED）', async () => {
    const fields = await failFields(async () => {
      throw netError('CERT_HAS_EXPIRED', 'certificate has expired')
    })
    assert.equal(fields.errorKind, 'tls')
  })

  it('http：非 2xx（503 带 httpStatus）', async () => {
    const fields = await failFields(async () => jsonResponse({}, { ok: false, status: 503 }))
    assert.equal(fields.errorKind, 'http')
    assert.equal(fields.httpStatus, 503)
    assert.equal(fields.stage, 'fetch')
    assert.deepEqual(keysOf(fields), ['errorKind', 'httpStatus', 'latencyMs', 'source', 'stage'])
  })

  it('bad-json：200 但正文不是 JSON', async () => {
    const fields = await failFields(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => 'not-json{',
    }))
    assert.equal(fields.errorKind, 'bad-json')
  })

  it('too-large：超过元数据字节墙', async () => {
    const fields = await failFields(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? String(300 * 1024) : null) },
      text: async () => '{}',
    }))
    assert.equal(fields.errorKind, 'too-large')
  })

  it('shape：名字对不上（结构校验失败）', async () => {
    const fields = await failFields(async () => jsonResponse({ ...releaseDoc(), name: 'other-package' }))
    assert.equal(fields.errorKind, 'shape')
  })

  it('channel：latest 与全量包文档都挑不出本通道发行版', async () => {
    const fields = await failFields({
      fetchImpl: scriptedFetch({
        latest: jsonResponse(releaseDoc('10.0.0-beta.1')),
        packument: jsonResponse({ name: TARGET, versions: {} }),
      }),
    })
    assert.equal(fields.errorKind, 'channel')
    assert.equal(fields.stage, 'channel')
  })

  it('unknown：未贴成因标签的错误（如磁盘读取抛错）按 unknown 兜底', async () => {
    const fields = await failFields({
      ports: {
        readInstalled: async () => {
          throw new Error('disk boom')
        },
      },
    })
    assert.equal(fields.errorKind, 'unknown')
    assert.equal(fields.stage, 'verify')
  })

  it('公开错误码不变：细分只进日志，抛出的 error.code 仍是 check-failed', async () => {
    const { core } = makeCore({
      fetchImpl: async () => {
        throw netError('ENOTFOUND', 'getaddrinfo ENOTFOUND registry.npmjs.org')
      },
    })
    await assert.rejects(
      () => core.check('user'),
      (error) => {
        assert.equal(error.code, 'check-failed')
        return true
      },
    )
  })
})

describe('#211-A check-conclusion 纯映射', () => {
  it('认得的成因原样回，认不得/没有标签一律 unknown', () => {
    assert.equal(checkErrorKindOf({ [CHECK_FAIL_CAUSE_KEY]: 'timeout' }), 'timeout')
    assert.equal(checkErrorKindOf({ [CHECK_FAIL_CAUSE_KEY]: 'bad-json' }), 'bad-json')
    assert.equal(checkErrorKindOf({ [CHECK_FAIL_CAUSE_KEY]: 'bogus' }), 'unknown')
    assert.equal(checkErrorKindOf(Object.assign(new Error('x'), { code: 'check-failed' })), 'unknown')
    assert.equal(checkErrorKindOf(null), 'unknown')
    assert.equal(checkErrorKindOf(undefined), 'unknown')
  })
})

// ---------------------------------------------------------------- 4. changelog 取数日志

function tarEntry(name, data) {
  const header = Buffer.alloc(512, 0)
  Buffer.from(name, 'utf8').copy(header, 0, 0, Math.min(Buffer.byteLength(name), 100))
  Buffer.from(`${data.length.toString(8).padStart(11, '0')}\0`, 'utf8').copy(header, 124)
  header[156] = 48 // '0'：普通文件
  Buffer.from('ustar\0', 'utf8').copy(header, 257)
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0)
  Buffer.from(data).copy(body)
  return Buffer.concat([header, body])
}

function makeTgz(files) {
  const parts = []
  for (const [name, text] of Object.entries(files)) parts.push(tarEntry(name, Buffer.from(text, 'utf8')))
  parts.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(parts))
}

const CHANGELOG_TGZ = makeTgz({
  'package/CHANGELOG.md': '# Changelog\n\n## [1.0.0] - 2026-10-01\n\n### Added\n\n- entry one\n',
})
const TARBALL_INTEGRITY = `sha512-${createHash('sha512').update(CHANGELOG_TGZ).digest('base64')}`
const PKG = 'my-notes-plugin'
const releaseRef = (integrity = TARBALL_INTEGRITY) => ({
  tarball: `${REGISTRY}${PKG}/-/${PKG}-1.0.0.tgz`,
  integrity,
  version: '1.0.0',
})

function tarballResponse({ ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => CHANGELOG_TGZ.buffer.slice(CHANGELOG_TGZ.byteOffset, CHANGELOG_TGZ.byteOffset + CHANGELOG_TGZ.byteLength),
  }
}

describe('#211-A 更新说明取数：tarball 取数落 update.registry.fetch', () => {
  it('取数成功：三格如实（httpStatus/latencyMs/registryHost），返回形态不变', async () => {
    const rows = []
    const outcome = await fetchReleaseChangelogOutcome(async () => tarballResponse(), releaseRef(), {
      targetPackageName: PKG,
      registryUrl: REGISTRY,
      registryHost,
      emitLog: (level, event, fields) => rows.push({ level, event, fields }),
    })
    assert.equal(outcome.status, 'ok')
    assert.ok(outcome.markdown && outcome.markdown.includes('entry one'))

    const fetchRows = rows.filter((row) => row.event === 'update.registry.fetch')
    assert.equal(fetchRows.length, 1)
    assert.deepEqual(keysOf(fetchRows[0].fields), ['httpStatus', 'latencyMs', 'registryHost'])
    assert.equal(fetchRows[0].fields.httpStatus, 200)
    assert.equal(fetchRows[0].fields.registryHost, registryHost)
    assert.equal(typeof fetchRows[0].fields.latencyMs, 'number')
    assert.equal(fetchRows[0].level, 'info')
  })

  it('取数抛错也留行：httpStatus 省略，latencyMs 照落', async () => {
    const rows = []
    const outcome = await fetchReleaseChangelogOutcome(
      async () => {
        throw new Error('network down')
      },
      releaseRef(),
      {
        targetPackageName: PKG,
        registryUrl: REGISTRY,
        registryHost,
        emitLog: (level, event, fields) => rows.push({ level, event, fields }),
      },
    )
    assert.equal(outcome.status, 'fetch-failed')
    const fetchRows = rows.filter((row) => row.event === 'update.registry.fetch')
    assert.equal(fetchRows.length, 1)
    assert.deepEqual(keysOf(fetchRows[0].fields), ['latencyMs', 'registryHost'])
    assert.equal(typeof fetchRows[0].fields.latencyMs, 'number')
  })

  it('非 2xx 也留行：httpStatus 如实带出', async () => {
    const rows = []
    const outcome = await fetchReleaseChangelogOutcome(async () => tarballResponse({ ok: false, status: 404 }), releaseRef(), {
      targetPackageName: PKG,
      registryUrl: REGISTRY,
      registryHost,
      emitLog: (level, event, fields) => rows.push({ level, event, fields }),
    })
    assert.equal(outcome.status, 'fetch-failed')
    const fetchRows = rows.filter((row) => row.event === 'update.registry.fetch')
    assert.equal(fetchRows.length, 1)
    assert.equal(fetchRows[0].fields.httpStatus, 404)
  })

  it('预检失败（integrity 不合规）不发取数行：没联网就没有取数事实', async () => {
    const rows = []
    const outcome = await fetchReleaseChangelogOutcome(async () => tarballResponse(), releaseRef('sha512-bad'), {
      targetPackageName: PKG,
      registryUrl: REGISTRY,
      registryHost,
      emitLog: (level, event, fields) => rows.push({ level, event, fields }),
    })
    assert.equal(outcome.status, 'fetch-failed')
    assert.equal(rows.length, 0)
  })

  it('发射口自己坏了也绝不挡取数', async () => {
    const outcome = await fetchReleaseChangelogOutcome(async () => tarballResponse(), releaseRef(), {
      targetPackageName: PKG,
      registryUrl: REGISTRY,
      registryHost,
      emitLog: () => {
        throw new Error('emitter boom')
      },
    })
    assert.equal(outcome.status, 'ok')
    assert.ok(outcome.markdown)
  })

  it('兼容口 fetchReleaseChangelogText 同样能带 emitLog（返回形态一字不动）', async () => {
    const rows = []
    const text = await fetchReleaseChangelogText(async () => tarballResponse(), releaseRef(), {
      targetPackageName: PKG,
      registryUrl: REGISTRY,
      registryHost,
      emitLog: (level, event, fields) => rows.push({ level, event, fields }),
    })
    assert.ok(text && text.includes('entry one'))
    assert.equal(rows.filter((row) => row.event === 'update.registry.fetch').length, 1)
  })
})
