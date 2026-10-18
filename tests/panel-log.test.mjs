/**
 * tests/panel-log.test.mjs —— 面板侧的日志行（#122）：挂载/动作/状态/语言行按清单发，
 * 重复状态不灌行（指纹去重），行里只有稳定码（ADR-0006），以及自建通道真的走 `<prefix>.logAppend`。
 *
 * 只测外部行为：注入假通道（或让面板自建、看假传输收到什么），断言事件名、字段、条数。
 * 不碰真机、不真联网、不真落盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel } from '../dist/panel.js'
import { createClientLogChannel } from '../dist/log/client-queue.js'

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

/** 假传输：按电话名回固定剧本，并记下每次调用。 */
function fakeCall(script = {}) {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) {
      return (
        script.status ?? {
          ok: true,
          snapshot: baseSnapshot(),
          manual: 'dsh plugin --profile web add --save-exact my-plugin@1.1.0',
          receipt: null,
          queue: baseQueue(),
        }
      )
    }
    if (name.endsWith('.updateCheck')) {
      return script.check ?? { ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'c1', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }
    }
    if (name.endsWith('.updateInstall')) {
      return script.install ?? { ok: true, snapshot: baseSnapshot({ job: null }), manual: null }
    }
    if (name.endsWith('.logAppend')) {
      return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
    }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

/** 注入用的假通道：攒着不发，flush 时把整批交进 batches。 */
function logChannel() {
  const batches = []
  const ch = createClientLogChannel({
    call: async (name, args) => {
      batches.push({ name, rows: args.rows })
      return { accepted: args.rows.length, dropped: 0 }
    },
    phoneName: 'wf.logAppend',
    timer: null,
    visibility: null,
    batchSize: 1000,
  })
  return { ch, batches }
}

function rowsOf(batches) {
  return batches.flatMap((b) => b.rows)
}

function copySpy() {
  const texts = []
  return { copyText: async (t) => texts.push(t), texts }
}

/** 等首绘那份异步状态回包落地（面板挂载是异步刷新的，动作要等快照到手才算数）。 */
async function settled() {
  await new Promise((r) => setTimeout(r, 20))
}

test('挂载即三行：mount + lang.applied + state（都是稳定码，无一句人话）', async () => {
  const { ch, batches } = logChannel()
  const { call } = fakeCall()
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call,
    pollMs: 60000,
    clientLog: { channel: ch, mount: 'entry' },
  })
  await ch.flush()
  const rows = rowsOf(batches)
  const mount = rows.find((r) => r.event === 'update.panel.mount')
  assert.deepEqual(mount.fields, { mode: 'entry', theme: 'default', lang: 'zh', pollMs: 60000 })
  assert.equal(mount.level, 'info')
  const lang = rows.find((r) => r.event === 'update.lang.applied')
  assert.equal(lang.fields.lang, mount.fields.lang, '两条行说的是同一次语言判定')
  assert.ok(['override', 'dom', 'navigator', 'default'].includes(lang.fields.source), String(lang.fields.source))
  const state = rows.find((r) => r.event === 'update.panel.state')
  assert.deepEqual(state.fields, { state: 'ready', theme: 'default', tokensApplied: 0, fallback: true })
  // 客户端行只许是协议白名单里那六个事件（多一个都算越界）。
  const allowed = new Set([
    'update.panel.mount',
    'update.panel.action',
    'update.panel.render.fail',
    'update.panel.state',
    'update.lang.applied',
    'update.log.degraded',
  ])
  for (const row of rows) assert.ok(allowed.has(row.event), `越界事件：${row.event}`)
  assert.equal(rows.filter((r) => r.event === 'update.panel.mount').length, 1, '一次挂载只记一条')
  assert.equal(rows.filter((r) => r.event === 'update.lang.applied').length, 1, '语言没变不多记')
  // 行只带稳定码：字符串字段里不许出现空白与中文（ADR-0006：人话由渲染层产出）。
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.fields)) {
      if (typeof value !== 'string') continue
      assert.match(value, /^[A-Za-z0-9._:@/-]*$/, `${row.event}.${key} 只能是稳定码，收到 ${JSON.stringify(value)}`)
    }
  }
  panel.unmount()
})

test('调用方点名主题语言：mount/state 如实记，fallback=false', async () => {
  const { ch, batches } = logChannel()
  const { call } = fakeCall()
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call,
    pollMs: 60000,
    theme: 'archive',
    locale: 'en',
    clientLog: { channel: ch },
  })
  await ch.flush()
  const rows = rowsOf(batches)
  assert.deepEqual(rows.find((r) => r.event === 'update.panel.mount').fields, {
    mode: 'embedded',
    theme: 'archive',
    lang: 'en',
    pollMs: 60000,
  })
  assert.deepEqual(rows.find((r) => r.event === 'update.lang.applied').fields, { lang: 'en', source: 'override' })
  assert.deepEqual(rows.find((r) => r.event === 'update.panel.state').fields, {
    state: 'ready',
    theme: 'archive',
    tokensApplied: 0,
    fallback: false,
  })
  panel.unmount()
})

test('每个动作一行；状态没变就不重复记状态行（轮询每秒重算也不灌）', async () => {
  const { ch, batches } = logChannel()
  const { call } = fakeCall()
  const panel = mountUpdatePanel(fakeContainer(), { pluginId: 'p', call, pollMs: 60000, clientLog: { channel: ch } })
  await settled()
  await ch.flush()
  const before = rowsOf(batches).filter((r) => r.event === 'update.panel.state').length
  assert.ok(before >= 1)

  await panel.act('toggle-changelog')
  await panel.act('toggle-changelog')
  await ch.flush()
  const rows = rowsOf(batches)
  const actions = rows.filter((r) => r.event === 'update.panel.action')
  assert.deepEqual(
    actions.map((r) => r.fields.action).filter((a) => a === 'toggle-changelog'),
    ['toggle-changelog', 'toggle-changelog']
  )
  for (const action of actions) {
    assert.deepEqual(
      Object.keys(action.fields),
      ['action', 'ok', 'errorKind', 'durationMs'],
      '非复制类动作只带成败与耗时，不带 bytes/truncated'
    )
    assert.equal(action.fields.ok, true, '点一下就成的动作 ok=true')
    assert.equal(action.fields.errorKind, null)
    assert.equal(typeof action.fields.durationMs, 'number')
  }
  assert.equal(
    rows.filter((r) => r.event === 'update.panel.state').length,
    before,
    '状态指纹没变，状态行不该多出来'
  )
  panel.unmount()
})

test('复制诊断：动作行带上这次复制了多少字节、有没有被截断', async () => {
  const { ch, batches } = logChannel()
  const { call } = fakeCall()
  const { copyText, texts } = copySpy()
  const panel = mountUpdatePanel(fakeContainer(), { pluginId: 'p', call, copyText, pollMs: 60000, clientLog: { channel: ch } })
  await settled()
  await panel.act('copy-diag')
  await ch.flush()
  const action = rowsOf(batches).find((r) => r.event === 'update.panel.action' && r.fields.action === 'copy-diag')
  assert.ok(action, '复制诊断必须留一行')
  assert.ok(action.fields.bytes > 0, '字节数来自真正交出去的那段文本')
  assert.equal(action.fields.truncated, false)
  assert.equal(texts.length, 1)
  panel.unmount()
})

test('不传 clientLog 即自建通道：走调用方前缀派生的 <prefix>.logAppend', async () => {
  const { call, log } = fakeCall()
  const panel = mountUpdatePanel(fakeContainer(), { pluginId: 'p', prefix: 'notes', call, pollMs: 60000 })
  await new Promise((r) => setTimeout(r, 1400))
  const append = log.filter((c) => c.name === 'notes.logAppend')
  assert.ok(append.length >= 1, `宿主电话名要从前缀派生，实际打到：${log.map((c) => c.name).join(',')}`)
  const events = append.flatMap((c) => c.args.rows.map((r) => r.event))
  assert.ok(events.includes('update.panel.mount'), '挂载行要送到宿主')
  assert.ok(events.includes('update.panel.state'))
  panel.unmount()
})

test('clientLog: null 即明确关掉：一行都不发', async () => {
  const { call, log } = fakeCall()
  const panel = mountUpdatePanel(fakeContainer(), { pluginId: 'p', prefix: 'notes', call, pollMs: 60000, clientLog: null })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(
    log.filter((c) => c.name.endsWith('.logAppend')).length,
    0
  )
  panel.unmount()
})
