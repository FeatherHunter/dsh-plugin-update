/**
 * tests/changelog-status.test.mjs
 *
 * #213 更新日志解析：六种状态、缓存边沿与清单升档。
 *
 * 覆盖（验收命令：node --test tests/changelog-status.test.mjs）：
 *   1. ok / empty / missing / fetch-failed / parse-degraded / cache-hit 六种状态，各在且仅在一条
 *      update.changelog.parse 行上；空行不该出现（内容相同也必须靠 version 区分）。
 *   2. 同一版本：第 1 次 1 行（ok），第 2 次再 +1 行（cache-hit），第 3 次 0 行。
 *   3. empty（包里是空 CHANGELOG.md）与 missing（包里根本没有）可区分。
 *   4. 两个版本交错：字段完全相同的两行互不压制（边沿指纹取自含 version 的行字段）。
 *   5. 负向断言：任何一行都不含路径 / URL / 令牌 / 自由文本 / 中文正文。
 *   6. 随包清单：#213 不增事件，update.changelog.parse 由 ondemand 升 resident 且边沿触发。
 *
 * 全程不联网：registry 响应由本文件自带的假件提供（tar / gzip / integrity 手搓，不跨测试文件复用）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { CHANGELOG_STATUSES } from '../dist/core/changelog/parse.js'
import { currentUpdateEventTable, isEdgeEvent, primeUpdateEventTable } from '../dist/log/manifest.js'

const REGISTRY = 'https://registry.npmjs.org/'
const PKG = 'my-notes-plugin'
const PARSE_EVENT = 'update.changelog.parse'

/** 冻结契约：六个状态与顺序（fd 见 #213 契约）。 */
const STATUSES = ['ok', 'empty', 'missing', 'fetch-failed', 'parse-degraded', 'cache-hit']
/** 冻结契约：update.changelog.parse 行字段（含 version，边沿指纹取自这些字段）。 */
const ROW_KEYS = ['cached', 'degraded', 'entries', 'source', 'status', 'truncated', 'version']

// ---------------------------------------------------------------- 假件：tarball / registry

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
  parts.push(Buffer.alloc(1024, 0)) // 两段全零块收尾
  return gzipSync(Buffer.concat(parts))
}

const tgzIntegrity = (tgz) => `sha512-${createHash('sha512').update(tgz).digest('base64')}`
const versionDocUrl = (version) => `${REGISTRY}${encodeURIComponent(PKG)}/${encodeURIComponent(version)}`
const tarballUrl = (version) => `${REGISTRY}${PKG}/-/${PKG}-${version}.tgz`

/** 按版本号造出有结构的更新说明：版本标题数就是 entries 期望值。 */
function changelogMarkdown(versions) {
  const lines = ['# Changelog', '']
  for (const version of versions) {
    lines.push(`## [${version}] - 2026-10-05`, '', '### Added', '', `- 中文条目 ${version}`, '')
  }
  return lines.join('\n')
}

const OK_ONE = changelogMarkdown(['1.0.0'])
const OK_TWO = changelogMarkdown(['1.1.0', '1.0.0'])
const OK_THREE = changelogMarkdown(['1.2.0', '1.1.0', '1.0.0'])
const OK_FOUR = changelogMarkdown(['1.3.0', '1.2.0', '1.1.0', '1.0.0'])
/** 有正文但拿不出「## [版本]」标题：解析降级。 */
const PROSE_ONLY = '# Changelog\n\n只写了散文，没有任何版本标题。\n'
/** 空文件：与「根本没有 CHANGELOG.md」必须分成两种结局。 */
const BLANK = '\n\n   \n'
const README_ONLY = { 'package/README.md': '# my-notes-plugin\n' }

/**
 * 官方源假件：按 URL 精确应答版本号文档与 tarball；非 200 的 tarball 用 tarballStatus 表达。
 * scenarios 形如 { '1.1.0': { files, tarballStatus? } }。
 */
function registryFetch(scenarios, calls) {
  const byUrl = new Map()
  for (const [version, scenario] of Object.entries(scenarios)) {
    const tgz = makeTgz(scenario.files)
    byUrl.set(versionDocUrl(version), {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: PKG,
          version,
          engines: { node: '>=22' },
          dist: { tarball: tarballUrl(version), integrity: tgzIntegrity(tgz) },
        }),
    })
    if (scenario.tarballStatus && scenario.tarballStatus !== 200) {
      const status = scenario.tarballStatus
      byUrl.set(tarballUrl(version), { ok: false, status, headers: { get: () => null }, text: async () => '' })
    } else {
      const copy = Buffer.from(tgz)
      byUrl.set(tarballUrl(version), {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '',
        arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      })
    }
  }
  return async (url) => {
    calls.push(url)
    const hit = byUrl.get(url)
    if (!hit) throw new Error(`unexpected-url:${url}`)
    return hit
  }
}

/** 一台只带假 registry 的宿主；fires 收全部日志行，calls 记全部联网。 */
function makeHost({ pluginId, scenarios }) {
  const calls = []
  const fires = []
  const host = createHostUpdate(
    {
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
      readerOverrides: { fetchImpl: registryFetch(scenarios, calls) },
    },
    { pluginId, targetPackageName: PKG },
  )
  return {
    host,
    calls,
    fires,
    parseRows: () => fires.filter((fire) => fire.event === PARSE_EVENT),
    rowsOf: (event) => fires.filter((fire) => fire.event === event),
  }
}

const askChangelog = (host, version) => host.handlers[host.phoneNames.updateChangelog]({ version })

/** 第 before+1 行必须是本次调用新落的那一行。 */
function singleNewRow(rows, before, label) {
  assert.equal(rows.length, before + 1, `${label}: 应恰好新落一行（实际新增 ${rows.length - before} 行）`)
  return rows[rows.length - 1]
}

function assertParsedRow(row, expected, label) {
  assert.ok(row, `${label}: 应有 update.changelog.parse 行`)
  assert.deepEqual(
    Object.keys(row.fields).sort(),
    ROW_KEYS,
    `${label}: 行字段应是冻结的七格（version/entries/truncated/degraded/status/cached/source）`,
  )
  assert.equal(row.fields.source, 'npm', `${label}: source 恒为 npm`)
  assert.equal(row.fields.version, expected.version, `${label}: version 应记下本次查询的版本`)
  assert.equal(typeof row.fields.entries, 'number', `${label}: entries 应是数字`)
  assert.equal(typeof row.fields.truncated, 'boolean', `${label}: truncated 应是布尔`)
  assert.equal(typeof row.fields.degraded, 'boolean', `${label}: degraded 应是布尔`)
  assert.equal(row.fields.status, expected.status, `${label}: status 应落 ${expected.status}`)
  assert.equal(row.fields.cached, expected.cached, `${label}: cached 应是 ${expected.cached}`)
  if (expected.entries !== undefined) {
    assert.equal(row.fields.entries, expected.entries, `${label}: entries 应是 ${expected.entries}`)
  }
  if (expected.degraded !== undefined) {
    assert.equal(row.fields.degraded, expected.degraded, `${label}: degraded 应是 ${expected.degraded}`)
  }
}

// ---------------------------------------------------------------- 六个用例

describe('#213 update.changelog.parse 六状态 / 缓存边沿 / 清单升档', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })

  it('六种状态各落一行：五行首取 + 同版本再取即 cache-hit', async () => {
    const scenarios = {
      '1.1.0': { files: { 'package/CHANGELOG.md': OK_TWO } },
      '1.2.0': { files: { 'package/CHANGELOG.md': BLANK } },
      '1.3.0': { files: README_ONLY },
      '1.4.0': { files: { 'package/CHANGELOG.md': OK_TWO }, tarballStatus: 500 },
      '1.5.0': { files: { 'package/CHANGELOG.md': PROSE_ONLY } },
    }
    const { host, parseRows, calls } = makeHost({ pluginId: 'cl-status-six', scenarios })

    const ok = await askChangelog(host, '1.1.0')
    assertParsedRow(
      singleNewRow(parseRows(), 0, 'ok'),
      { version: '1.1.0', status: 'ok', cached: false, entries: 2, degraded: false },
      'ok',
    )
    assert.equal(ok.ok, true, 'ok: 回包 ok 为真')
    assert.equal(ok.status, 'ok', 'ok: 回包 status 应是内容状态')
    assert.equal(ok.cached, false, 'ok: 首取不是缓存命中')
    assert.equal(ok.markdown, OK_TWO, 'ok: 回包带原文')

    const empty = await askChangelog(host, '1.2.0')
    // 空文件也没有可用内容：degraded 为真，与老写法 markdown===null 同结论；
    // 「文件在但空着」这层意思由 status:'empty' + entries:0 承担，不由 degraded 位承担。
    assertParsedRow(
      singleNewRow(parseRows(), 1, 'empty'),
      { version: '1.2.0', status: 'empty', cached: false, entries: 0, degraded: true },
      'empty',
    )
    assert.equal(empty.ok, true, 'empty: 仍是正常回包')
    assert.equal(empty.status, 'empty', 'empty: 空文件自成一档，不并进 missing')
    assert.equal(empty.cached, false, 'empty: 首取不是缓存命中')
    assert.equal(empty.markdown, null, 'empty: 空文件不给内容')

    const missing = await askChangelog(host, '1.3.0')
    assertParsedRow(
      singleNewRow(parseRows(), 2, 'missing'),
      { version: '1.3.0', status: 'missing', cached: false, entries: 0, degraded: true },
      'missing',
    )
    assert.equal(missing.ok, true, 'missing: 仍是正常回包')
    assert.equal(missing.status, 'missing', 'missing: 包里没有更新说明')
    assert.equal(missing.cached, false, 'missing: 首取不是缓存命中')
    assert.equal(missing.markdown, null, 'missing: 既有的 null 回包不变')

    const failed = await askChangelog(host, '1.4.0')
    assertParsedRow(
      singleNewRow(parseRows(), 3, 'fetch-failed'),
      { version: '1.4.0', status: 'fetch-failed', cached: false, entries: 0, degraded: true },
      'fetch-failed',
    )
    assert.equal(failed.ok, true, 'fetch-failed: 抓取失败仍是正常回包')
    assert.equal(failed.status, 'fetch-failed', 'fetch-failed: tarball 非 200 归抓取失败')
    assert.equal(failed.cached, false, 'fetch-failed: 首取不是缓存命中')
    assert.equal(failed.markdown, null, 'fetch-failed: 不给内容')

    const degraded = await askChangelog(host, '1.5.0')
    assertParsedRow(
      singleNewRow(parseRows(), 4, 'parse-degraded'),
      { version: '1.5.0', status: 'parse-degraded', cached: false, entries: 0, degraded: true },
      'parse-degraded',
    )
    assert.equal(degraded.status, 'parse-degraded', 'parse-degraded: 有正文但解析不出结构')
    assert.equal(degraded.cached, false, 'parse-degraded: 首取不是缓存命中')
    assert.equal(degraded.markdown, PROSE_ONLY, 'parse-degraded: 原文照给，只是解析降级')

    const callsBeforeHit = calls.length
    const hit = await askChangelog(host, '1.1.0')
    assertParsedRow(
      singleNewRow(parseRows(), 5, 'cache-hit'),
      { version: '1.1.0', status: 'cache-hit', cached: true, degraded: false },
      'cache-hit',
    )
    assert.equal(hit.cached, true, 'cache-hit: 回包自报缓存命中')
    assert.equal(hit.status, 'ok', 'cache-hit: 回包 status 是内容状态（ok），缓存事实由 cached 表达')
    assert.equal(hit.markdown, OK_TWO, 'cache-hit: 命中的是同一份原文')
    assert.equal(calls.length, callsBeforeHit, 'cache-hit: 不再联网')

    assert.deepEqual(
      parseRows().map((row) => row.fields.status),
      STATUSES,
      '六种状态各恰好一行：ok / empty / missing / fetch-failed / parse-degraded / cache-hit',
    )

    // 解析降级也进缓存：内容在但结构拿不出，再取仍是 cache-hit。
    // 缓存命中行的 degraded 按缓存里那条**内容态**算（parse-degraded → true），只有 status 记 cache-hit。
    const degradedHit = await askChangelog(host, '1.5.0')
    assertParsedRow(
      singleNewRow(parseRows(), 6, 'parse-degraded→cache-hit'),
      { version: '1.5.0', status: 'cache-hit', cached: true, degraded: true },
      'parse-degraded→cache-hit',
    )
    assert.equal(degradedHit.markdown, PROSE_ONLY, 'parse-degraded→cache-hit: 缓存里就是那份散文')
  })

  it('缓存边沿：第二次命中一行、第三次零行、回包仍报 cached', async () => {
    const { host, parseRows, calls } = makeHost({
      pluginId: 'cl-status-cache-edge',
      scenarios: { '2.1.0': { files: { 'package/CHANGELOG.md': OK_THREE } } },
    })

    const first = await askChangelog(host, '2.1.0')
    assertParsedRow(
      singleNewRow(parseRows(), 0, '首取'),
      { version: '2.1.0', status: 'ok', cached: false, entries: 3, degraded: false },
      '首取',
    )
    assert.equal(first.cached, false, '首取: 回包 cached 为假')

    const callsBeforeHit = calls.length
    const second = await askChangelog(host, '2.1.0')
    assert.equal(parseRows().length, 2, '第二次: 全局只多一行')
    assertParsedRow(
      parseRows()[1],
      { version: '2.1.0', status: 'cache-hit', cached: true },
      '第二次',
    )
    assert.equal(second.cached, true, '第二次: 回包 cached 为真')
    assert.equal(second.markdown, OK_THREE, '第二次: 命中同一份原文')
    assert.equal(calls.length, callsBeforeHit, '第二次: 不再联网')

    const third = await askChangelog(host, '2.1.0')
    assert.equal(parseRows().length, 2, '第三次: 不再新落行（边沿只在状态变化时记）')
    assert.equal(third.cached, true, '第三次: 回包仍报缓存命中')
    assert.equal(third.markdown, OK_THREE, '第三次: 命中同一份原文')
  })

  it('空文件与缺文件可区分：empty ≠ missing', async () => {
    const { host, parseRows } = makeHost({
      pluginId: 'cl-status-empty-vs-missing',
      scenarios: {
        '3.1.0': { files: { 'package/CHANGELOG.md': BLANK } },
        '3.2.0': { files: README_ONLY },
      },
    })

    const emptyReply = await askChangelog(host, '3.1.0')
    assertParsedRow(
      singleNewRow(parseRows(), 0, 'empty'),
      { version: '3.1.0', status: 'empty', cached: false, entries: 0, degraded: true },
      'empty',
    )
    const missingReply = await askChangelog(host, '3.2.0')
    assertParsedRow(
      singleNewRow(parseRows(), 1, 'missing'),
      { version: '3.2.0', status: 'missing', cached: false, entries: 0, degraded: true },
      'missing',
    )

    assert.equal(emptyReply.markdown, null, 'empty: 两个版本都无内容可展示')
    assert.equal(missingReply.markdown, null, 'missing: 两个版本都无内容可展示')
    assert.notEqual(emptyReply.status, missingReply.status, '回包层面必须能分辨两种无内容')
    const rows = parseRows()
    assert.notDeepEqual(rows[0].fields, rows[1].fields, '落点层面必须能分辨两种无内容')
    assert.notEqual(
      JSON.stringify(rows[0].fields),
      JSON.stringify(rows[1].fields),
      '两种无内容的行不能长得一模一样',
    )
    assert.equal(rows[0].fields.degraded, true, 'empty: 空文件也没有可用内容，degraded 为真（与老写法 markdown===null 同结论）')
    assert.equal(rows[1].fields.degraded, true, 'missing: 缺文件同样没有可用内容')
    assert.notEqual(rows[0].fields.status, rows[1].fields.status, '两种无内容只能靠 status 分辨')
    assert.equal(rows[0].fields.entries, 0, '空文件没有条目')
    assert.equal(rows[1].fields.entries, 0, '缺文件没有条目')
  })

  it('两个版本交错：字段相同的行互不压制（边沿指纹含 version）', async () => {
    const identical = { files: { 'package/CHANGELOG.md': OK_ONE } }
    const { host, parseRows } = makeHost({
      pluginId: 'cl-status-two-versions',
      scenarios: { '4.1.0': identical, '4.2.0': { files: { 'package/CHANGELOG.md': OK_ONE } } },
    })

    await askChangelog(host, '4.1.0')
    assertParsedRow(
      singleNewRow(parseRows(), 0, '4.1.0 首取'),
      { version: '4.1.0', status: 'ok', cached: false, entries: 1, degraded: false },
      '4.1.0 首取',
    )
    await askChangelog(host, '4.2.0')
    assertParsedRow(
      singleNewRow(parseRows(), 1, '4.2.0 首取'),
      { version: '4.2.0', status: 'ok', cached: false, entries: 1, degraded: false },
      '4.2.0 首取',
    )
    const rows = parseRows()
    assert.equal(rows.length, 2, '两个版本各落一行')
    assert.notDeepEqual(rows[0].fields, rows[1].fields, '两行必须靠 version 区分')
    assert.deepEqual(
      { ...rows[0].fields, version: 'x' },
      { ...rows[1].fields, version: 'x' },
      '除 version 外两行必须完全同形',
    )

    await askChangelog(host, '4.1.0')
    await askChangelog(host, '4.2.0')
    assert.deepEqual(
      parseRows().map((row) => row.fields.status),
      ['ok', 'ok', 'cache-hit', 'cache-hit'],
      '两版交错：各自的首取与命中都要留痕，缓存也不串版本',
    )
    await askChangelog(host, '4.1.0')
    assert.equal(parseRows().length, 4, '回到 4.1.0 已是 cache-hit，不再新落行')
  })

  it('负向断言：任何一行都不含路径 / URL / 令牌 / 自由文本', async () => {
    const scenarios = {
      '5.1.0': { files: { 'package/CHANGELOG.md': OK_FOUR } },
      '5.2.0': { files: { 'package/CHANGELOG.md': BLANK } },
      '5.3.0': { files: README_ONLY },
      '5.4.0': { files: { 'package/CHANGELOG.md': OK_TWO }, tarballStatus: 500 },
      '5.5.0': { files: { 'package/CHANGELOG.md': PROSE_ONLY } },
    }
    const { host, parseRows, rowsOf, fires } = makeHost({ pluginId: 'cl-status-negatives', scenarios })

    for (const version of ['5.1.0', '5.2.0', '5.3.0', '5.4.0', '5.5.0', '5.1.0']) {
      await askChangelog(host, version)
    }
    assert.equal(parseRows().length, 6, '六次调用应落六行（最后一次是 5.1.0 的 cache-hit）')
    assert.equal(
      rowsOf('update.log.degraded').length,
      0,
      '字段全部过清单白名单，不该出现降级行',
    )

    const needles = ['C:\\', '/home/', 'node_modules', 'http://', 'https://', 'Bearer ', 'ghp_', 'npm_', 'AKIA', PKG]
    for (const fire of fires) {
      const text = `${fire.event} ${JSON.stringify(fire.fields)}`
      for (const needle of needles) {
        assert.equal(text.includes(needle), false, `行里不该出现 ${needle}：${text}`)
      }
      assert.equal(/\p{Script=Han}/u.test(text), false, `行里不该出现中文正文：${text}`)
    }
  })

  it('随包清单：#213 不增事件；changelog.parse 升常驻 + 边沿触发', () => {
    const raw = JSON.parse(readFileSync(new URL('../event-list.update.json', import.meta.url), 'utf8'))
    const names = Object.keys(raw.events)
    assert.equal(names.length, 27, '#213 只升档不增事件（#207 之后的事故总数 27）')

    const kinds = { resident: 0, ondemand: 0, selfmon: 0 }
    for (const name of names) kinds[raw.events[name].kind] += 1
    assert.deepEqual(
      kinds,
      { resident: 20, ondemand: 6, selfmon: 1 },
      'update.changelog.parse 由按需升常驻：19/7/1 → 20/6/1',
    )
    assert.equal(kinds.resident + kinds.ondemand, 26, '常驻 + 按需总数仍是 26')

    const entry = raw.events[PARSE_EVENT]
    assert.ok(entry, `清单里应有 ${PARSE_EVENT}`)
    assert.equal(entry.kind, 'resident', '升档后 kind 应是 resident')
    assert.deepEqual([...entry.fields].sort(), ROW_KEYS, '清单声明的字段与冻结契约一致')
    assert.deepEqual(raw.fieldEnums?.[PARSE_EVENT]?.status, STATUSES, 'fieldEnums.status 应声明六个状态')

    assert.deepEqual(CHANGELOG_STATUSES, STATUSES, 'src/core/changelog/parse.ts 应导出冻结的六状态表')

    primeUpdateEventTable()
    assert.equal(
      isEdgeEvent(PARSE_EVENT, currentUpdateEventTable()),
      true,
      '清单须把 changelog.parse 标成边沿触发，指纹去重才生效',
    )
    assert.ok(String(entry.guard).includes('边沿触发'), 'guard 文案应写明边沿触发')
  })
})
