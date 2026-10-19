/**
 * scripts/log-smoke.mjs —— 批量日志端到端冒烟（#208 已验证的 6 个场景）。
 *
 * 用真 dist 公共入口 + 假传输 + 按插件标识绑定的收集落点，把「一批三家 / 批量偏好失败去重 /
 * logAppend 转发 / 无属主静默 / 预查抛错后续跑 / 排队行归属」跑一遍，每个场景打印一行
 * `PASS <name>`，全过最后打印 `SMOKE PASSED` 并 exit 0；任一断言失败打印
 * `FAIL <name>: <detail>` 并 exit 1。
 *
 * 纪律：只依赖 Node 内置 + dist 公共入口 + tests/helpers/batch-log-harness.mjs；
 * 临时目录用 fs.mkdtemp(os.tmpdir() + ...) 建，finally 里删干净，仓库里不留文件。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash8 } from '../dist/shared/hash.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { primeUpdateEventTable } from '../dist/log/manifest.js'
import {
  SILENT,
  bind,
  collector,
  fakeTransport,
  installOverrides,
  mkTarget,
  rowsOf,
  seedQueue,
  unbindAll,
} from '../tests/helpers/batch-log-harness.mjs'

const HEX8 = /^[0-9a-f]{8}$/

primeUpdateEventTable()

/** 真临时目录：使用范围落这儿，跑完整个目录删掉。 */
async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-log-smoke-'))
  try {
    return await fn(dir)
  } finally {
    unbindAll()
    await rm(dir, { recursive: true, force: true })
  }
}

/** 一条断言失败的详情：名称 + 消息（详情里的路径都是临时目录，不外泄仓库内容）。 */
function detailOf(error) {
  return error && error.message ? error.message : String(error)
}

/** 7 个批量电话的短名（宿主 phoneNames 的键）。 */
const BATCH_PHONES = ['status', 'check', 'install', 'resume', 'cancel', 'prefs', 'prefsSave']

// ---------- s1 一批三家：入场行 / 失败行 / 总账，三事件同一 sessionHash ----------

async function s1(dir) {
  const transport = fakeTransport({
    a: { check: { kind: 'failed', error: 'check-failed' } },
    b: {
      check: { kind: 'update', version: '2.0.0' },
      install: { kind: 'failed', error: 'install-failed' },
    },
    self: { check: { kind: 'current' } },
  })
  const host = createMultiHostUpdate(
    { scope: { homeDir: dir, profileDir: dir }, logCtx: SILENT, transport },
    { prefix: 'life', targets: [mkTarget('a'), mkTarget('b'), mkTarget('self')], selfKey: 'self' },
  )
  const owner = collector()
  const a = collector()
  const b = collector()
  bind('plugin-self', owner.sink)
  bind('plugin-a', a.sink)
  bind('plugin-b', b.sink)

  const reply = await host.handlers['life.batchInstall']({})
  assert.equal(reply.ok, true, 'a 查失败不整批回错：如实收敛进账本')

  // 入场行：恰好一条，三计数 + sessionHash 四字段。
  const asked = rowsOf(owner, 'update.batch.entry.request')
  assert.equal(asked.length, 1, '一批只落一条入场行')
  assert.equal(asked[0].level, 'info')
  assert.deepEqual(
    Object.keys(asked[0].fields).sort(),
    ['foreignCount', 'ownCount', 'sessionHash', 'total'],
    '入场行字段恰好四个（三计数 + sessionHash）',
  )
  assert.equal(asked[0].fields.total, 3)
  assert.equal(asked[0].fields.ownCount, 1, 'own = 自己那家')
  assert.equal(asked[0].fields.foreignCount, 2, 'foreign = 其余两家')
  assert.match(asked[0].fields.sessionHash, HEX8, 'sessionHash 是 8 位十六进制')
  assert.equal(asked[0].fields.sessionHash, hash8(reply.session.id), 'sessionHash = hash8(批次 id)')

  // a 查失败：落 a 自己目录（不是静默丢行，也不落属主）；批量层没有电话失败行。
  // 属主目录里可能出现目标自身单插件电话的失败行（如 p-self.updateStatus 读不到使用范围），
  // 这里按 method 的批量前缀过滤——「a 查失败静默」指的是批量层不记一行。
  const aFailed = rowsOf(a, 'update.batch.entry.fail')
  assert.equal(aFailed.length, 1, 'a 查失败落它自己目录一条（#209 起不再静默）')
  assert.equal(aFailed[0].fields.stage, 'check')
  assert.equal(aFailed[0].fields.index, 0)
  const batchPhoneFails = owner.rows.filter(
    (row) => row.event === 'host.call.fail' && String(row.fields.method ?? '').startsWith('life.'),
  )
  assert.equal(batchPhoneFails.length, 0, 'a 查失败不是批量电话失败：属主无批量失败行')

  // b 装失败：正好一条，stage/index/targetHash/sessionHash 对位。
  const bFailed = rowsOf(b, 'update.batch.entry.fail')
  assert.equal(bFailed.length, 1, '一个目标失败一条')
  assert.equal(bFailed[0].level, 'warn')
  assert.equal(bFailed[0].fields.stage, 'install', '装失败记 install 阶段')
  assert.equal(bFailed[0].fields.index, 1, 'b 在整批 [a,b,self] 里排第 1（0 起）')
  assert.match(bFailed[0].fields.targetHash, HEX8, 'targetHash 是 8 位十六进制指纹')
  assert.equal(bFailed[0].fields.targetHash, hash8('b'), 'targetHash = hash8(目标键)')
  assert.equal(bFailed[0].fields.errorKind, 'install-failed')

  // 总账：ok + failed + skipped = total，stoppedBecause=finished。
  const summary = rowsOf(owner, 'update.batch.summary')
  assert.equal(summary.length, 1, '一次收尾一条总账')
  assert.equal(summary[0].level, 'info')
  const fields = summary[0].fields
  for (const key of ['ok', 'failed', 'skipped', 'total', 'sessionHash', 'stoppedBecause', 'durationMs']) {
    assert.ok(key in fields, '总账要有字段 ' + key)
  }
  assert.equal(fields.total, 3)
  assert.equal(fields.ok, 1, 'self 已最新')
  assert.equal(fields.failed, 2, 'a 查失败 + b 装失败')
  assert.equal(fields.skipped, 0)
  assert.equal(fields.stoppedBecause, 'finished', '全部跑完（有失败也算收尾）')
  assert.match(fields.sessionHash, HEX8)
  assert.equal(fields.ok + fields.failed + fields.skipped, fields.total, '三个计数必须把 total 分完')
  assert.equal(typeof fields.durationMs, 'number')

  // 三事件同一批：同一个 8 位 hex。
  const hashes = [asked[0].fields.sessionHash, bFailed[0].fields.sessionHash, fields.sessionHash]
  assert.equal(new Set(hashes).size, 1, '入场 / 失败 / 总账三事件共用一个 sessionHash')
  assert.match(hashes[0], HEX8)
  host.dispose()
}

// ---------- s2 批量偏好保存失败：落一行 host.call.fail，连续同码去重，成功清记忆 ----------

async function s2(dir) {
  const host = createMultiHostUpdate(
    { scope: { homeDir: dir, profileDir: dir }, logCtx: SILENT, transport: fakeTransport({}) },
    { prefix: 'life', targets: [mkTarget('self')], selfKey: 'self' },
  )
  const owner = collector()
  bind('plugin-self', owner.sink)

  const bad = await host.handlers['life.batchPrefsSave']({ checkOnOpen: 'not-a-bool' })
  assert.equal(bad.ok, false, '非布尔 checkOnOpen 回 ok:false')
  let rows = rowsOf(owner, 'host.call.fail')
  assert.equal(rows.length, 1, '属主目录落 1 条 host.call.fail')
  const fields = rows[0].fields
  assert.deepEqual(
    Object.keys(fields).sort(),
    ['error', 'errorHash', 'kind', 'method', 'pluginId'],
    '失败行字段恰好五个',
  )
  assert.equal(fields.method, 'life.batchPrefsSave', 'method 用全名')
  assert.equal(fields.kind, 'batch-prefs-save', 'kind 用短名')
  assert.equal(fields.error, 'check-failed', 'error 是稳定码')
  assert.match(fields.errorHash, HEX8, 'errorHash 是 8 位十六进制')
  assert.equal(fields.errorHash, hash8('life.batchPrefsSave|check-failed'), 'errorHash = hash8(method|error)')
  assert.equal(fields.pluginId, 'plugin-self', '落属主 pluginId')

  const badAgain = await host.handlers['life.batchPrefsSave']({ checkOnOpen: 'not-a-bool' })
  assert.equal(badAgain.ok, false)
  assert.equal(rowsOf(owner, 'host.call.fail').length, 1, '同一 method 连续同码只记首次')

  const ok = await host.handlers['life.batchPrefsSave']({ checkOnOpen: true })
  assert.equal(ok.ok, true)
  assert.equal(rowsOf(owner, 'host.call.fail').length, 1, '成功本身不发失败行')

  const badAfterOk = await host.handlers['life.batchPrefsSave']({ checkOnOpen: 'not-a-bool' })
  assert.equal(badAfterOk.ok, false)
  rows = rowsOf(owner, 'host.call.fail')
  assert.equal(rows.length, 2, '成功清除记忆后，再失败重新记一条')
  assert.equal(rows[0].fields.errorHash, rows[1].fields.errorHash, '同一 method 同一 error：errorHash 相同')
  host.dispose()
}

// ---------- s3 有属主时 logAppend 登记并转发属主 ----------

async function s3(dir) {
  const host = createMultiHostUpdate(
    { scope: { homeDir: dir, profileDir: dir }, logCtx: SILENT, transport: fakeTransport({}) },
    { prefix: 'life', targets: [mkTarget('self')], selfKey: 'self' },
  )
  const owner = collector()
  bind('plugin-self', owner.sink)

  assert.equal(host.phoneNames.logAppend, 'life.logAppend', 'phoneNames.logAppend 派生自批量前缀')
  assert.equal(typeof host.handlers['life.logAppend'], 'function', '批量电话表登记 life.logAppend')

  const ts = Date.now()
  const reply = await host.handlers['life.logAppend']({
    rows: [
      { level: 'info', event: 'update.panel.mount', fields: { mode: 'batch' }, ts },
      { level: 'info', event: 'update.panel.action', fields: { action: 'check', ok: true }, ts },
    ],
  })
  assert.equal(reply.accepted, 2, '两行客户端日志都被接收')
  assert.equal(reply.dropped, 0)
  assert.equal(rowsOf(owner, 'update.panel.mount').length, 1, 'update.panel.mount 落属主')
  assert.equal(rowsOf(owner, 'update.panel.action').length, 1, 'update.panel.action 落属主')
  host.dispose()
}

// ---------- s4 无属主（没 selfKey）：批量级三事件 0 条、批量电话失败行 0 条、不登记 logAppend ----------

async function s4(dir) {
  // (a) 同范围、无 selfKey：批量推进照旧，但批量级三事件一行不发。
  const host = createMultiHostUpdate(
    { scope: { homeDir: dir, profileDir: dir }, logCtx: SILENT, transport: fakeTransport({}) },
    { prefix: 'life', targets: [mkTarget('a'), mkTarget('b')] },
  )
  const a = collector()
  const b = collector()
  const selfTarget = collector()
  bind('plugin-a', a.sink)
  bind('plugin-b', b.sink)
  bind('plugin-self', selfTarget.sink)

  const reply = await host.handlers['life.batchInstall']({})
  assert.equal(reply.ok, true, '没有落点不影响推进与回包')
  const all = [...a.rows, ...b.rows, ...selfTarget.rows]
  assert.equal(all.filter((row) => row.event.startsWith('update.batch.')).length, 0, '没有属主：批量级三事件 0 条')
  assert.equal('logAppend' in host.phoneNames, false, '没有属主就不登记 logAppend')
  assert.equal('life.logAppend' in host.handlers, false)
  host.dispose()

  // (b) 无属主 + 批量电话真失败：失败行一条也不发（目标自身单插件行另算，按 method 前缀 life. 过滤）。
  const scopeOne = join(dir, 'scope-one')
  const scopeOther = join(dir, 'scope-other')
  await mkdir(scopeOne, { recursive: true })
  await mkdir(scopeOther, { recursive: true })
  const targets = [mkTarget('a'), { ...mkTarget('b'), profileDir: scopeOther }, mkTarget('self')]
  const crossHost = createMultiHostUpdate({ scope: { homeDir: scopeOne, profileDir: scopeOne }, logCtx: SILENT }, {
    prefix: 'life',
    targets,
  })
  const a2 = collector()
  const b2 = collector()
  const self2 = collector()
  bind('plugin-a', a2.sink)
  bind('plugin-b', b2.sink)
  bind('plugin-self', self2.sink)
  for (const short of BATCH_PHONES) {
    const failed = await crossHost.handlers[crossHost.phoneNames[short]]({})
    assert.equal(failed.ok, false, '跨范围拒绝：' + short)
  }
  const rows = [...a2.rows, ...b2.rows, ...self2.rows]
  const batchPhoneFails = rows.filter(
    (row) => row.event === 'host.call.fail' && String(row.fields.method ?? '').startsWith('life.'),
  )
  assert.equal(batchPhoneFails.length, 0, '没有属主：批量电话失败行一条不发')
  crossHost.dispose()
}

// ---------- s5 预查抛错 → ok:false + host.call.fail；续跑后装超时 / 查失败各一行 ----------

async function s5(dir) {
  let bCheckCalls = 0
  const transport = {
    check: async (key) => {
      if (key === 'a') return { kind: 'update', version: '2.0.0' }
      if (key === 'b') {
        bCheckCalls += 1
        // 第一次（预查）抛错 → batchInstall ok:false；续跑那次给失败结论 → entry.fail stage=check。
        if (bCheckCalls === 1) throw new Error('check crashed')
        return { kind: 'failed', error: 'check-failed' }
      }
      return { kind: 'current' }
    },
    install: async (key) =>
      key === 'a'
        ? { kind: 'failed', error: 'install-failed', stage: 'timeout' }
        : { kind: 'done', restartRequired: false },
  }
  const host = createMultiHostUpdate(
    { scope: { homeDir: dir, profileDir: dir }, logCtx: SILENT, transport },
    { prefix: 'life', targets: [mkTarget('a'), mkTarget('b'), mkTarget('self')], selfKey: 'self' },
  )
  const owner = collector()
  const a = collector()
  const b = collector()
  bind('plugin-self', owner.sink)
  bind('plugin-a', a.sink)
  bind('plugin-b', b.sink)

  const failed = await host.handlers['life.batchInstall']({})
  assert.equal(failed.ok, false, '预查抛错沿旧口径回 ok:false')
  const phoneFails = rowsOf(owner, 'host.call.fail')
  assert.equal(phoneFails.length, 1, '批量电话失败落属主一条')
  assert.equal(phoneFails[0].fields.method, 'life.batchInstall')
  assert.equal(phoneFails[0].fields.kind, 'batch-install')
  assert.equal(phoneFails[0].fields.error, 'check-failed', '抛错折成稳定码 check-failed')

  const bBefore = rowsOf(b, 'update.batch.entry.fail').length
  const resumed = await host.handlers['life.batchResume']({})
  assert.equal(resumed.ok, true, '续跑成功')
  assert.equal(resumed.resumed, true, '盘上有未完成批次：续跑')
  assert.equal(host.lastRun.stoppedBecause, 'finished')

  const aFailed = rowsOf(a, 'update.batch.entry.fail')
  assert.equal(aFailed.length, 1, 'a 装失败一行')
  assert.equal(aFailed[0].fields.stage, 'timeout', 'a 等收尾超时记 stage=timeout')
  assert.equal(aFailed[0].fields.index, 0)
  // b：预查抛错那一下已落一条 unknown（#209「哪家没查成」也要说），续跑查失败再落一条稳定码行。
  const bFailed = rowsOf(b, 'update.batch.entry.fail')
  assert.equal(bBefore, 1, '预查抛错先落一条失败行')
  assert.equal(bFailed.length, bBefore + 1, '续跑查失败再落一条')
  const bResumed = bFailed[bFailed.length - 1]
  assert.equal(bResumed.fields.stage, 'check', 'b 查失败记 stage=check')
  assert.equal(bResumed.fields.index, 1, 'b 在整批 [a,b,self] 里排第 1')
  assert.equal(bResumed.fields.errorKind, 'check-failed', '续跑那次查失败的稳定码')
  const summaryRows = rowsOf(owner, 'update.batch.summary')
  // 预查抛错那一下也是一次「停止」：先记一条 stoppedBecause=error；续跑跑完再记一条 finished。
  assert.equal(summaryRows.length, 2, '停止行（error）+ 续跑收尾行（finished）各一条')
  assert.equal(summaryRows[0].fields.stoppedBecause, 'error', '预查抛错记一条异常停止')
  assert.equal(summaryRows[1].fields.stoppedBecause, 'finished', '续跑跑完照样收尾一条总账')
  assert.equal(summaryRows[1].fields.failed, 2)
  host.dispose()
}

// ---------- s6 排队行归属：共享队列端口写下的 update.queue.transition 落目标、不落属主 ----------

async function s6(dir) {
  // 队首是别家（真队列文件；不注入 readQueue/writeQueue 才会走批量共享端口）。
  await seedQueue(dir, [
    { pluginId: 'other-plugin', requestId: 'req-other', targetVersion: null, enqueuedAt: Date.now() },
  ])
  const host = createMultiHostUpdate(
    {
      scope: { homeDir: dir, profileDir: dir },
      logCtx: SILENT,
      readerOverrides: installOverrides(dir, 'pkg-a', async () => {}),
    },
    { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
  )
  const owner = collector()
  const a = collector()
  bind('plugin-self', owner.sink)
  bind('plugin-a', a.sink)

  // 单独调目标自己的单插件装电话：只占位不装（enqueueOnly），不经过批量驱动。
  const reply = await host.handlers['p-a.updateInstall']({ enqueueOnly: true, requestId: 'req-smoke-a' })
  assert.equal(reply.ok, true, 'enqueueOnly 占位成功')

  const queueRows = rowsOf(a, 'update.queue.transition')
  assert.ok(queueRows.length >= 1, '排队边沿要留队列行')
  assert.equal(queueRows[0].fields.phase, 'queued', '排队相位记 queued')
  assert.ok(Number.isInteger(queueRows[0].fields.position), 'position 是整数')
  assert.equal(queueRows[0].fields.position, 2, '别家排在前面：position 是 1 起的队列位置（2）')
  assert.equal(rowsOf(owner, 'update.queue.transition').length, 0, '队列行跟动作方（目标）走，不落属主')
  host.dispose()
}

// ---------- 主流程：六个场景逐个跑，全过才 SMOKE PASSED ----------

const SCENARIOS = [
  ['s1', s1],
  ['s2', s2],
  ['s3', s3],
  ['s4', s4],
  ['s5', s5],
  ['s6', s6],
]

async function main() {
  let failed = 0
  for (const [name, fn] of SCENARIOS) {
    try {
      __resetSharedUpdateReaderForTests()
      await withTemp(fn)
      console.log('PASS ' + name)
    } catch (error) {
      failed += 1
      console.log('FAIL ' + name + ': ' + detailOf(error))
    }
  }
  if (failed > 0) {
    console.log('SMOKE FAILED: ' + failed + '/' + SCENARIOS.length)
    process.exit(1)
  }
  console.log('SMOKE PASSED')
  process.exit(0)
}

await main()
