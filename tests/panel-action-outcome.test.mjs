/**
 * tests/panel-action-outcome.test.mjs —— #214 动作行成败四态：每一下点击都要有结果交代。
 *
 * 四种结果都落在同一条 update.panel.action 上（不新增事件）：
 *   ok=true                     动作跑完且没把面板带进失败态；
 *   ok=false errorKind=<稳定码>  动作成功返回但锁存了失败（面板进入失败页）；
 *   ok=false errorKind='thrown'  动作直接抛错（只留 8 位指纹，不留原话）；
 *   ok=false errorKind='busy'    已有动作在途，这次点击被拒。
 * 另外守契约：event-list 里 action 字段必须含 errorHash，render.fail 的 phase/kind 枚举随清单发布。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mountUpdatePanel } from '../dist/panel.js'
import { createClientLogChannel } from '../dist/log/client-queue.js'
import { hash8 } from '../dist/hash.js'

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

function baseQueue() {
  return { busy: false, owner: null, waiting: [], position: null }
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

/**
 * 假传输：状态/检查/安装按剧本回；检查可挂起（deferred）或抛错，供 busy/thrown 态使用。
 */
function fakeTransport(script = {}) {
  let releaseCheck = null
  let checkCalls = 0
  const checkGate = script.checkPending ? new Promise((resolve) => { releaseCheck = resolve }) : null
  const checkSnapshot = script.checkSnapshot ?? baseSnapshot()
  const statusReply = {
    ok: true,
    snapshot: script.snapshot ?? baseSnapshot(),
    manual: 'dsh plugin --profile web add --save-exact my-plugin@1.1.0',
    receipt: null,
    queue: baseQueue(),
  }
  const call = async (name, args) => {
    if (name.endsWith('.updateStatus')) return statusReply
    if (name.endsWith('.updateCheck')) {
      if (script.checkThrows) throw new Error(String(script.checkThrows))
      // 挂载自带的自动检查先放行（它就在那里），之后由测试控制是否挂起。
      if (checkGate && checkCalls++ >= 1) await checkGate
      return { ok: true, snapshot: checkSnapshot, manual: null, receipt: { checkId: 'c1', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }
    }
    if (name.endsWith('.updateInstall')) return { ok: true, snapshot: baseSnapshot(), manual: null }
    if (name.endsWith('.logAppend')) return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
    throw new Error('unknown-phone:' + name)
  }
  return { call, releaseCheck: () => releaseCheck?.(), statusReply, checkSnapshot }
}

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

async function settled() {
  await new Promise((r) => setTimeout(r, 20))
}

async function mount(script = {}) {
  const { ch, batches } = logChannel()
  const transport = fakeTransport(script)
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call: transport.call,
    pollMs: 60000,
    clientLog: { channel: ch, mount: 'test' },
  })
  await settled()
  await ch.flush()
  batches.length = 0
  return { panel, ch, batches, transport }
}

/** 无更新快照：不触发挂载后的自动检查，好让「在途动作」完全由测试控制。 */
function upToDateSnapshot() {
  return baseSnapshot({ latestVersion: '1.0.0', runningVersion: '1.0.0', installedVersion: '1.0.0', canInstall: false })
}

function actionRows(batches) {
  return rowsOf(batches).filter((r) => r.event === 'update.panel.action')
}

test('成功动作：ok=true、errorKind=null、只有耗时（没有指纹）', async () => {
  const { panel, ch, batches } = await mount()
  await panel.act('toggle-changelog')
  await ch.flush()
  const rows = actionRows(batches)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].level, 'info')
  assert.equal(rows[0].fields.action, 'toggle-changelog')
  assert.equal(rows[0].fields.ok, true)
  assert.equal(rows[0].fields.errorKind, null)
  assert.equal(typeof rows[0].fields.durationMs, 'number')
  assert.ok(rows[0].fields.durationMs >= 0)
  assert.equal('errorHash' in rows[0].fields, false, '成功不编指纹')
  panel.unmount()
})

test('锁存失败动作：ok=false、errorKind=稳定码、errorHash 是 8 位十六进制', async () => {
  const { panel, ch, batches } = await mount({ checkThrows: 'check-boom' })
  await panel.act('check')
  await ch.flush()
  const rows = actionRows(batches)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fields.ok, false)
  assert.equal(rows[0].fields.errorKind, 'check-failed')
  assert.match(String(rows[0].fields.errorHash), /^[0-9a-f]{8}$/)
  panel.unmount()
})

test('动作直接抛错：ok=false、errorKind=thrown、只留指纹不留原话，且 act 照样向外抛', async () => {
  const { panel, ch, batches, transport } = await mount({ snapshot: upToDateSnapshot(), checkSnapshot: upToDateSnapshot() })
  // 动作体里的取数在 try 里：让 skip 分支读到的 latestVersion 抛错，才能走到 act 的 thrown 分支。
  Object.defineProperty(transport.checkSnapshot, 'latestVersion', {
    configurable: true,
    get() {
      throw new Error('action-boom')
    },
  })
  await assert.rejects(() => panel.act('skip'), /action-boom/)
  await ch.flush()
  const rows = actionRows(batches)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fields.ok, false)
  assert.equal(rows[0].fields.errorKind, 'thrown')
  assert.equal(rows[0].fields.errorHash, hash8('action-boom'))
  assert.equal(JSON.stringify(rows[0].fields).includes('action-boom'), false, '原话不落行')
  panel.unmount()
})

test('忙态动作：已有动作在途，这次点击 ok=false、errorKind=busy', async () => {
  const { panel, ch, batches, transport } = await mount({ checkPending: true, snapshot: upToDateSnapshot() })
  const first = panel.act('check')
  await new Promise((r) => setTimeout(r, 5))
  await panel.act('check')
  await ch.flush()
  const busyRows = actionRows(batches).filter((r) => r.fields.errorKind === 'busy')
  assert.equal(busyRows.length, 1)
  assert.equal(busyRows[0].fields.ok, false)
  assert.equal(typeof busyRows[0].fields.durationMs, 'number')
  transport.releaseCheck()
  await first
  await ch.flush()
  const firstRow = actionRows(batches).find((r) => r.fields.action === 'check' && r.fields.ok === true)
  assert.ok(firstRow, '在途那次仍以成功结局落行')
  panel.unmount()
})

test('契约：action 字段含 errorHash，render.fail 的 phase/kind 枚举随清单发布', () => {
  const raw = JSON.parse(readFileSync(new URL('../event-list.update.json', import.meta.url), 'utf8'))
  assert.ok(raw.events['update.panel.action'].fields.includes('errorHash'))
  assert.deepEqual(raw.fieldEnums['update.panel.render.fail'].phase, ['mount', 'paint', 'poll', 'global'])
  assert.deepEqual(raw.fieldEnums['update.panel.render.fail'].kind, [
    'container',
    'plugin-id',
    'call',
    'prefix',
    'poll-ms',
    'mode',
    'auto-check',
    'theme',
    'theme-tokens',
    'locale',
    'render',
    'transport',
    'uncaught',
    'unhandled',
  ])
})
