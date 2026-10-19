/**
 * tests/log-contract.test.mjs —— issue #210（P0-1）：事件契约要能机器表达。
 *
 * 钉住四件事（验收标准逐条）：
 *   1. 清单可以声明「字段允许的枚举值」；dev 模式写错即抛，运行时只丢该字段、
 *      整行其余字段仍落盘，并产生一条去重的降级记录（含事件名与字段名）。
 *   2. 清单读取失败时，健康回包显示契约缺失状态，且字段门禁不被静默绕过（有计数可查）。
 *   3. 负断言：降级记录不含路径 / URL / 宿主原话（ADR-0006）。
 *   4. 客户端行经 logAppend 进同一条管道时，字段级裁剪口径一致（不因一个坏字段丢整行）。
 *
 * 只测外部行为：dist 公开出口 + 真清单 + 假落点，不碰真机、不写真实日志目录。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const gate = await import('../dist/core/gate.js')
const log = await import('../dist/log/index.js')
const logManifest = await import('../dist/log/manifest.js')
const hostMod = await import('../dist/host.js')
const codes = await import('../dist/shared/codes.js')

const { parseEventListManifest, pruneEventFields, lintEventList, mergeUpdateEvents } = gate
const {
  createLogRouter,
  createLogEmitter,
  __resetUpdateEventTableForTests,
  loadUpdateEventTable,
  updateContractStatus,
} = log
// 两个测试缝只住在模块里，不从 `./log` 公开出口外放（消费者拿不到，防止有人伪造契约健康）。
const { __loadUpdateEventTableForTests, __forceUpdateContractStatusForTests } = logManifest
const { createHostUpdate, __resetSharedUpdateReaderForTests } = hostMod

function sample() {
  return {
    version: 1,
    pluginId: 'my-plugin',
    fieldEnums: {
      'update.wire.ready': { logSink: ['external', 'self', 'off'] },
      'update.panel.action': { action: ['check', 'install'] },
      'update.log.degraded': { reason: ['unknown-field', 'invalid-enum'] },
    },
    events: {
      'update.wire.ready': {
        level: 'info',
        kind: 'resident',
        fields: ['logSink', 'logDirHash'],
      },
      'update.panel.action': {
        level: 'info',
        kind: 'resident',
        fields: ['action'],
      },
      'update.log.degraded': {
        level: 'warn',
        kind: 'selfmon',
        fields: ['reason', 'event', 'field'],
      },
    },
  }
}

function collectSink(rows) {
  return { fire: (level, event, fields) => rows.push({ level, event, fields }) }
}

function makeEmitter(rows, opts = {}) {
  const router = createLogRouter()
  router.bind('p', collectSink(rows))
  return createLogEmitter({
    resolve: (id) => router.resolve(id),
    table: opts.table === undefined ? () => parseEventListManifest(sample()) : opts.table,
    ...(opts.mode ? { mode: opts.mode } : {}),
  })
}

beforeEach(() => {
  __forceUpdateContractStatusForTests(null)
  __resetUpdateEventTableForTests()
  __resetSharedUpdateReaderForTests()
})

describe('#210 清单：枚举声明可解析、可合并、坏声明直接拒', () => {
  it('枚举声明被解析并保留，整份清单过尺子全绿', () => {
    const parsed = parseEventListManifest(sample())
    assert.deepEqual(parsed.fieldEnums['update.wire.ready'], { logSink: ['external', 'self', 'off'] })
    const linted = lintEventList(parsed)
    assert.deepEqual(linted.red, [])
    assert.deepEqual(linted.yellow, [])
  })

  it('坏声明直接抛：字段未声明、事件未声明、空枚举、重复值、非字符串', () => {
    const cases = [
      { event: 'no.such.event', field: 'x', values: ['a'] },
      { event: 'update.wire.ready', field: 'notDeclared', values: ['a'] },
      { event: 'update.wire.ready', field: 'logSink', values: [] },
      { event: 'update.wire.ready', field: 'logSink', values: ['self', 'self'] },
      { event: 'update.wire.ready', field: 'logSink', values: ['self', 42] },
    ]
    for (const item of cases) {
      const raw = sample()
      raw.fieldEnums[item.event] = { ...(raw.fieldEnums[item.event] ?? {}), [item.field]: item.values }
      assert.throws(() => parseEventListManifest(raw), /事件清单|异常|invalid/i, JSON.stringify(item))
    }
  })

  it('合并清单时枚举取并集（谁都不许因为合并丢掉自己的枚举）', () => {
    const base = sample()
    const own = sample()
    own.pluginId = 'other-plugin'
    own.fieldEnums = {
      'update.wire.ready': { logSink: ['self', 'off'] },
      'brand.new': { x: ['one'] },
    }
    own.events = {
      'update.wire.ready': {
        level: 'info',
        kind: 'resident',
        fields: ['logSink', 'logDirHash'],
      },
      'brand.new': { level: 'info', kind: 'resident', fields: ['x'] },
    }
    const merged = mergeUpdateEvents(base, own)
    assert.deepEqual(merged.manifest.fieldEnums['update.wire.ready'].logSink, ['external', 'self', 'off'])
    assert.deepEqual(merged.manifest.fieldEnums['brand.new'], { x: ['one'] })
  })
})

describe('#210 字段级裁剪：未知字段与非法枚举只丢该字段', () => {
  it('pruneEventFields 只摘不合规的键，其余原样留下', () => {
    const table = parseEventListManifest(sample())
    const ok = pruneEventFields(table, 'update.wire.ready', { logSink: 'self', logDirHash: 'h' })
    assert.deepEqual(ok.prunedFields, [])
    assert.deepEqual(ok.keptFields, { logSink: 'self', logDirHash: 'h' })

    const badEnum = pruneEventFields(table, 'update.wire.ready', { logSink: 'bogus', logDirHash: 'h' })
    assert.deepEqual(badEnum.prunedFields, [{ field: 'logSink', reason: 'invalid-enum' }])
    assert.deepEqual(badEnum.keptFields, { logDirHash: 'h' })

    const unknown = pruneEventFields(table, 'update.wire.ready', { logSink: 'self', extra: 1 })
    assert.deepEqual(unknown.prunedFields, [{ field: 'extra', reason: 'unknown-field' }])
    assert.deepEqual(unknown.keptFields, { logSink: 'self' })

    const missing = pruneEventFields(table, 'no.such.event', { a: 1 })
    assert.equal(missing.unknownEvent, true)

    // 声明了枚举的字段不许用 null/undefined 冒充「没写」：缺省应是整格不出现。
    const nullEnum = pruneEventFields(table, 'update.wire.ready', { logSink: null, logDirHash: 'h' })
    assert.deepEqual(nullEnum.prunedFields, [{ field: 'logSink', reason: 'invalid-enum' }])
    assert.deepEqual(nullEnum.keptFields, { logDirHash: 'h' })
    const undefinedEnum = pruneEventFields(table, 'update.wire.ready', { logSink: undefined })
    assert.deepEqual(undefinedEnum.prunedFields, [{ field: 'logSink', reason: 'invalid-enum' }])
  })

  it('lintEventList 也查枚举声明的结构（列级尺子不能只看字段名）', () => {
    const broken = parseEventListManifest(sample())
    broken.fieldEnums['update.wire.ready'].logSink = []
    broken.fieldEnums['update.panel.action'].notDeclared = ['x']
    broken.fieldEnums['no.such.event'] = { x: ['a'] }
    const linted = lintEventList(broken)
    assert.equal(linted.ok, false)
    assert.ok(linted.red.some((line) => line.includes('fieldEnums') && line.includes('update.wire.ready')))
    assert.ok(linted.red.some((line) => line.includes('undeclared field notDeclared')))
    assert.ok(linted.red.some((line) => line.includes('unknown event no.such.event')))
  })

  it('运行时：整行仍落盘，降级记录含事件名与字段名且去重', () => {
    const rows = []
    const emitter = makeEmitter(rows)
    assert.equal(emitter.emit('info', 'update.panel.action', { action: 'install', extra: 'x' }, { pluginId: 'p' }), true)
    assert.equal(emitter.emit('info', 'update.panel.action', { action: 'nope', extra: 'y' }, { pluginId: 'p' }), true)
    assert.equal(emitter.emit('info', 'update.panel.action', { action: 'nope', extra: 'z' }, { pluginId: 'p' }), true)

    const landed = rows.filter((r) => r.event === 'update.panel.action')
    assert.equal(landed.length, 3, '坏字段不该带走整行')
    assert.deepEqual(landed[0].fields, { action: 'install' })
    assert.deepEqual(landed[1].fields, {}, '非法枚举值被摘掉，事件行本身仍在')

    const degraded = rows.filter((r) => r.event === 'update.log.degraded')
    assert.deepEqual(degraded.map((r) => [r.fields.reason, r.fields.event, r.fields.field]), [
      ['unknown-field', 'update.panel.action', 'extra'],
      ['invalid-enum', 'update.panel.action', 'action'],
    ], '同一 (原因,事件,字段) 只记首次')
    const counts = emitter.counts()
    assert.equal(counts.prunedFields, 5)
    assert.deepEqual(counts.prunedByReason, { 'unknown-field': 3, 'invalid-enum': 2 })
    assert.equal(counts.dropped, 0)
  })

  it('dev 模式：写错枚举当场抛（不能把契约漂移带进发布）', () => {
    const rows = []
    const emitter = makeEmitter(rows, { mode: 'throw' })
    assert.throws(
      () => emitter.emit('info', 'update.wire.ready', { logSink: 'bogus' }, { pluginId: 'p' }),
      /not in event list/
    )
    assert.throws(
      () => emitter.emit('info', 'update.wire.ready', { logSink: 'self', extra: 'x' }, { pluginId: 'p' }),
      /not in event list/
    )
    // 抛出的行不记「已裁剪」：否则同一漂移会先记字段级降级、再被 catch 记 emit-threw。
    assert.equal(emitter.counts().prunedFields, 0)
    const degraded = rows.filter((row) => row.event === 'update.log.degraded')
    assert.ok(degraded.every((row) => row.fields.reason === 'emit-threw'), JSON.stringify(degraded))
  })

  it('负断言：降级记录只有 reason/event/field，绝无路径或 URL 原文', () => {
    const rows = []
    const emitter = makeEmitter(rows)
    emitter.emit('info', 'update.panel.action', {
      action: 'check',
      'C:\\Users\\someone\\secret': 1,
      'https://evil.example/token': 2,
    }, { pluginId: 'p' })
    const degraded = rows.filter((r) => r.event === 'update.log.degraded')
    assert.ok(degraded.length >= 1, '至少留下一条降级记录')
    for (const row of degraded) assert.deepEqual(Object.keys(row.fields).sort(), ['event', 'field', 'reason'])
    const text = JSON.stringify(degraded)
    assert.ok(!text.includes('someone'), '路径原文不许进降级记录：' + text)
    assert.ok(!/https?:\/\//.test(text), 'URL 原文不许进降级记录：' + text)
    assert.ok(!text.includes('evil.example'), '主机名原文不许进降级记录：' + text)
  })
})

describe('#210 契约健康：读不到清单不静默放行', () => {
  it('正常加载：状态 ok，条数与真清单一致', () => {
    const table = loadUpdateEventTable()
    assert.ok(table, '随包清单必须读得到')
    const status = updateContractStatus()
    assert.equal(status.state, 'ok')
    assert.equal(status.file, 'event-list.update.json')
    assert.equal(status.events, Object.keys(table.events).length)
  })

  it('读不到 / JSON 坏 / 形状坏：三种失败分得清，门禁回 null 不冒充已校验', () => {
    const cases = [
      [() => { throw new Error('ENOENT') }, 'missing', 'read'],
      [() => '{ not json', 'invalid', 'json'],
      [() => JSON.stringify({ version: 1, pluginId: 'x', events: [] }), 'invalid', 'shape'],
    ]
    for (const [readText, state, failure] of cases) {
      __resetUpdateEventTableForTests()
      const table = __loadUpdateEventTableForTests(readText)
      assert.equal(table, null)
      const status = updateContractStatus()
      assert.equal(status.state, state, String(readText))
      assert.equal(status.failure, failure)
    }
  })

  it('没有清单时发射口如实计 unvalidated，不冒充「已过白名单」', () => {
    const rows = []
    const emitter = makeEmitter(rows, { table: () => null })
    assert.equal(emitter.emit('info', 'update.panel.action', { action: 'check', extra: 'x' }, { pluginId: 'p' }), true)
    assert.equal(emitter.counts().unvalidated, 1)
    assert.equal(emitter.counts().prunedFields, 0)
    assert.equal(rows[0].fields.extra, 'x', '清单缺失时不裁剪（也不假装校验过）')
  })

  it('unvalidated 只数真正落盘的行：准入跳过 / 无落点的不算', () => {
    const rows = []
    const router = createLogRouter()
    router.bind('p', { fire: (level, event, fields) => rows.push({ level, event, fields }), isEnabled: () => false })
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table: () => null })
    assert.equal(emitter.emit('info', 'update.panel.action', { action: 'check' }, { pluginId: 'p' }), false)
    assert.equal(emitter.counts().unvalidated, 0, '被准入跳过的行没落盘，不能算「未校验落盘」')
    assert.equal(emitter.counts().skipped, 1)
    const noSink = createLogEmitter({ resolve: () => null, table: () => null })
    assert.equal(noSink.emit('info', 'update.panel.action', { action: 'check' }, { pluginId: 'p' }), false)
    assert.equal(noSink.counts().unvalidated, 0)
    assert.equal(rows.length, 0)
  })

  it('健康回包（updateStatus）带上契约状态', async () => {
    const fires = []
    const host = createHostUpdate(
      {
        logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
        readerOverrides: {
          runningVersion: '1.0.0',
          profileDir: 'C:\\fake\\profile',
          profileName: 'web',
          homeDir: 'C:\\fake\\home',
          now: () => 1_000_000,
          nodeVersion: '22.0.0',
          environmentKind: 'cli',
          readInstalled: async () => ({
            profileName: 'web',
            environmentKind: 'cli',
            homeDir: 'C:\\fake\\home',
            profileDir: 'C:\\fake\\profile',
            installedVersion: '1.0.0',
            packageValid: true,
            sourceInstall: false,
            blockedReason: null,
            installationKey: 'k',
            eligible: true,
          }),
          readJob: async () => null,
          writeJob: async () => {},
          tryAcquireLock: async () => true,
          releaseLock: async () => {},
          backupJob: async () => {},
          runInstall: async () => {},
        },
      },
      { pluginId: 'contract-host', prefix: 'wf' }
    )
    const okReply = await host.handlers['wf.updateStatus']({})
    assert.equal(okReply.logContract.state, 'ok')
    assert.equal(typeof okReply.logContract.unvalidated, 'number', '健康回包要带「没尺子仍落盘」的行数')

    __forceUpdateContractStatusForTests({
      state: 'missing',
      file: 'event-list.update.json',
      events: 0,
      failure: 'read',
    })
    __resetSharedUpdateReaderForTests()
    const missingReply = await host.handlers['wf.updateStatus']({})
    assert.equal(missingReply.logContract.state, 'missing')
    assert.equal(missingReply.logContract.failure, 'read')
  })
})

describe('#210 客户端行也走同一把尺子（logAppend）', () => {
  const TARGET = 'third-party-plugin'
  function makeHost(fires) {
    return createHostUpdate(
      {
        logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
        readerOverrides: {
          runningVersion: '1.0.0',
          profileDir: 'C:\\fake\\profile',
          profileName: 'web',
          homeDir: 'C:\\fake\\home',
          now: () => 1_000_000,
          nodeVersion: '22.0.0',
          environmentKind: 'cli',
          targetPackageName: TARGET,
          readInstalled: async () => ({
            profileName: 'web',
            environmentKind: 'cli',
            homeDir: 'C:\\fake\\home',
            profileDir: 'C:\\fake\\profile',
            installedVersion: '1.0.0',
            packageValid: true,
            sourceInstall: false,
            blockedReason: null,
            installationKey: 'k',
            eligible: true,
          }),
          readJob: async () => null,
          writeJob: async () => {},
          tryAcquireLock: async () => true,
          releaseLock: async () => {},
          backupJob: async () => {},
          runInstall: async () => {},
        },
      },
      { pluginId: TARGET, prefix: 'wf' }
    )
  }

  it('一个未声明字段只丢该字段，整行接收并留一条降级记录', async () => {
    const fires = []
    const host = makeHost(fires)
    const reply = await host.handlers['wf.logAppend']({
      rows: [{ level: 'info', event: 'update.panel.action', fields: { action: 'check', bogus: 1 }, ts: Date.now() }],
    })
    assert.deepEqual(reply, { accepted: 1, dropped: 0 })
    const actionRow = fires.find((f) => f.event === 'update.panel.action')
    assert.deepEqual(actionRow.fields, { action: 'check' })
    const degraded = fires.find((f) => f.event === 'update.log.degraded')
    assert.equal(degraded.fields.reason, 'unknown-field')
    assert.equal(degraded.fields.event, 'update.panel.action')
    assert.equal(degraded.fields.field, 'bogus')
  })
})

describe('#210 随包清单本身带上机器表达', () => {
  it('update.log.degraded 声明 event/field 与 reason 枚举（含 invalid-enum）', () => {
    const raw = JSON.parse(readFileSync(join(PKG_DIR, 'event-list.update.json'), 'utf8'))
    const entry = raw.events['update.log.degraded']
    assert.deepEqual(entry.fields, ['reason', 'event', 'field'])
    assert.ok(raw.fieldEnums['update.log.degraded'].reason.includes('invalid-enum'))
    assert.ok(raw.fieldEnums['update.log.degraded'].reason.includes('unknown-field'))
    assert.ok(raw.fieldEnums['update.log.degraded'].reason.includes('no-dsh-log'))
    const parsed = parseEventListManifest(raw)
    assert.deepEqual(lintEventList(parsed).red, [])
    assert.deepEqual(lintEventList(parsed).yellow, [])
  })

  it('至少三类高频字段的枚举随清单发布（可被第二家与门禁读到）', () => {
    const raw = JSON.parse(readFileSync(join(PKG_DIR, 'event-list.update.json'), 'utf8'))
    assert.deepEqual(raw.fieldEnums['update.wire.ready'].logSink, [
      'external',
      'external-unverified',
      'self',
      'off',
    ])
    assert.deepEqual(raw.fieldEnums['update.install.verify'].result, [
      'completed',
      'restart-required',
      'failed',
      'interrupted',
    ])
  })

  it('随包清单换名发布时仍保留枚举声明（机器事实不能在第一跳丢掉）', async () => {
    const built = await log.buildUpdateManifest('third-party-plugin')
    assert.ok(built.manifest)
    assert.equal(built.manifest.pluginId, 'third-party-plugin')
    assert.deepEqual(built.manifest.fieldEnums['update.wire.ready'].logSink, [
      'external',
      'external-unverified',
      'self',
      'off',
    ])
    // 原因枚举的权威在随包清单本身：这里只验「发布出来的那一跳没丢值」，
    // 不硬编码清单内容（#214 增删原因时不必回来改本断言）。
    const rawReasons = JSON.parse(readFileSync(join(PKG_DIR, 'event-list.update.json'), 'utf8'))
      .fieldEnums['update.log.degraded'].reason
    assert.deepEqual(built.manifest.fieldEnums['update.log.degraded'].reason, rawReasons)
  })

  it('交给 dsh-log 的清单（条目形状）不被顶层扩展键破坏', async () => {
    // 真正的验收：dsh-log 0.3.4 的条目校验不认 enums 这类新键，顶层未知键才收；
    // 这里直接拿它的解析器过一遍我们 buildUpdateManifest 的产物。
    const dshConfig = await import('dsh-log')
    const built = await log.buildUpdateManifest('third-party-plugin')
    assert.ok(built.manifest)
    const accepted = dshConfig.parseEventListManifest(built.manifest)
    assert.equal(accepted.pluginId, 'third-party-plugin')
    assert.equal(Object.keys(accepted.events).length, Object.keys(built.manifest.events).length)
  })
})

describe('#211 多源真相字段一次补齐（状态/检查/接线/挂载）', () => {
  const raw = JSON.parse(readFileSync(join(PKG_DIR, 'event-list.update.json'), 'utf8'))
  const enums = (event) => raw.fieldEnums[event] ?? {}

  it('status.changed 八格真值：运行版/磁盘版/在册/身份/阻挡原因/未知原因', () => {
    assert.deepEqual(raw.events['update.status.changed'].fields, [
      'kind',
      'latest',
      'runningVersion',
      'installedVersion',
      'registered',
      'identity',
      'blockedReason',
      'unknownCause',
    ])
    assert.deepEqual(enums('update.status.changed').kind, ['update-available', 'up-to-date', 'unknown'])
    assert.deepEqual(enums('update.status.changed').identity, [
      'update',
      'first-install',
      'up-to-date',
      'unknown',
    ])
    assert.deepEqual(enums('update.status.changed').blockedReason, ['none', ...codes.BLOCKED_REASONS])
    assert.deepEqual(enums('update.status.changed').unknownCause, [
      'no-latest',
      'running-version-unknown',
      'compare-failed',
    ])
  })

  it('check.done 带阻挡与回退、数据源枚举；check.fail 带延迟与数据源、错误类别细化', () => {
    assert.deepEqual(raw.events['update.check.done'].fields, [
      'ok',
      'current',
      'latest',
      'channel',
      'source',
      'latencyMs',
      'blockedReason',
      'fallback',
      'dataSource',
    ])
    assert.deepEqual(enums('update.check.done').blockedReason, ['none', ...codes.BLOCKED_REASONS])
    assert.deepEqual(enums('update.check.done').dataSource, ['npm-version', 'npm-channel'])
    assert.deepEqual(raw.events['update.check.fail'].fields, [
      'stage',
      'errorKind',
      'httpStatus',
      'latencyMs',
      'source',
    ])
    // 日志专用失败类别：不得混入公开稳定码（面板/诊断仍按 code 分支，ADR-0006）。
    assert.deepEqual(enums('update.check.fail').errorKind, [
      'timeout',
      'network',
      'dns',
      'tls',
      'http',
      'bad-json',
      'too-large',
      'shape',
      'channel',
      'unknown',
    ])
    const stable = new Set([...codes.STABLE_CODES, ...codes.CORE_ERROR_CODES])
    for (const kind of enums('update.check.fail').errorKind) {
      assert.ok(!stable.has(kind), `errorKind ${kind} 不得是公开稳定码`)
    }
  })

  it('wire.ready 带更新器版本/副本层级/宿主形态；logSink 能记外部落点未验证', () => {
    assert.deepEqual(raw.events['update.wire.ready'].fields, [
      'logSink',
      'logDirHash',
      'updaterVersion',
      'copyLevel',
      'hostKind',
    ])
    assert.deepEqual(enums('update.wire.ready').logSink, ['external', 'external-unverified', 'self', 'off'])
    assert.deepEqual(enums('update.wire.ready').copyLevel, ['profile', 'nested', 'repo', 'unknown'])
    assert.deepEqual(enums('update.wire.ready').hostKind, ['desktop', 'desktop-manager', 'cli'])
  })

  it('panel.mount 带自动检查状态（四值）', () => {
    assert.deepEqual(raw.events['update.panel.mount'].fields, ['mode', 'theme', 'lang', 'pollMs', 'autoCheck'])
    assert.deepEqual(enums('update.panel.mount').autoCheck, ['started', 'recent', 'disabled', 'failed'])
  })

  it('新枚举不改变事件档位与总数（27 = 20 常驻 / 6 按需 / 1 自监控）', () => {
    assert.equal(raw.events['update.status.changed'].kind, 'resident')
    assert.equal(raw.events['update.status.changed'].level, 'info')
    assert.equal(raw.events['update.check.done'].kind, 'resident')
    assert.equal(raw.events['update.check.fail'].kind, 'resident')
    assert.equal(raw.events['update.check.fail'].level, 'warn')
    assert.equal(raw.events['update.wire.ready'].kind, 'resident')
    assert.equal(raw.events['update.panel.mount'].kind, 'resident')
    const counts = gate.computeEventCounts(raw)
    assert.deepEqual(counts, { resident: 20, ondemand: 6, selfmon: 1 })
    assert.equal(counts.resident + counts.ondemand + counts.selfmon, 27)
    assert.deepEqual(lintEventList(parseEventListManifest(raw)).red, [])
  })
})
