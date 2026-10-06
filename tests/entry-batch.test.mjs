/**
 * tests/entry-batch.test.mjs —— 批量感知的更新入口件（#49）。
 *
 * 只测外部行为：挂上、点一下、看容器里的 HTML、看打电话记录、看 label()/summary()。
 * 传输与容器全用假件，不碰真机、不真联网、不真装；七行用假 call 直接喂不同相位。
 * 铁律「任何路径都不自动安装」写成负向断言：整个生命周期里没有 .batchInstall 调用。
 * 聚合口径与批量面板总账同一份数法（batchLedgerCounts）：忙失败占位翻回可更新，不报成失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  batchEntryLabelFor,
  batchEntryStateKind,
  batchEntrySummary,
  mountUpdateBatchEntry,
} from '../dist/entry-batch.js'

function snapshotOf(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.2.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function rowOf(overrides = {}) {
  return {
    key: 'a',
    title: '甲',
    phase: 'ready',
    targetVersion: '1.2.0',
    restartRequired: false,
    error: null,
    snapshot: snapshotOf(),
    manual: null,
    queue: null,
    profileName: null,
    ...overrides,
  }
}

/** 七家不同相位：可更新 / 安装中 / 待查 / 查新版中 / 已最新 / 待重启 / 失败（下游 ilife 的七目标形状）。 */
function sevenRows() {
  return [
    rowOf({ key: 'bill', title: '记账', phase: 'ready', targetVersion: '1.2.0' }),
    rowOf({ key: 'calorie', title: '卡路里', phase: 'installing', targetVersion: '1.2.0' }),
    rowOf({ key: 'memo', title: '备忘录', phase: 'pending', targetVersion: null }),
    rowOf({ key: 'schedule', title: '作息', phase: 'checking', targetVersion: null }),
    rowOf({ key: 'home', title: '居家', phase: 'current', targetVersion: null, snapshot: snapshotOf({ latestVersion: '1.0.0', canInstall: false }) }),
    rowOf({ key: 'chef', title: '大厨', phase: 'failed', targetVersion: '1.2.0', error: 'install-failed' }),
    rowOf({ key: 'life-pack', title: '爱生活', phase: 'done', targetVersion: null, restartRequired: true }),
  ]
}

function statusReply(rows, extra = {}) {
  return { ok: true, session: { id: 's' }, rows, progress: null, ...extra }
}

function checkReply(rows, extra = {}) {
  return { ok: true, session: { id: 's' }, rows, progress: null, ...extra }
}

/** 假传输：只认批量五电话里的 status/check，其余抛错；记下每一次调用。 */
function fakeCall(script = {}) {
  const log = []
  const pick = (s, fallback) => (typeof s === 'function' ? s(log) : s === undefined ? fallback : s)
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.batchStatus')) return pick(script.status, statusReply([]))
    if (name.endsWith('.batchCheck')) return pick(script.check, checkReply([]))
    if (name.endsWith('.batchInstall')) return pick(script.install, statusReply([]))
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== listener))
    },
    click(attrs) {
      const matches = (sel) => {
        const m = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel)
        if (!m) return false
        if (!Object.prototype.hasOwnProperty.call(attrs, m[1])) return false
        return m[2] === undefined || attrs[m[1]] === m[2]
      }
      const target = {
        closest: (sel) => (matches(sel) ? { getAttribute: (name) => attrs[name] ?? null } : null),
      }
      for (const listener of [...(listeners.get('click') ?? [])]) {
        if (!(listeners.get('click') ?? []).includes(listener)) continue
        listener({ target })
      }
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length
    },
  }
}

const CLICK_ENTRY = { 'data-dsh-upd-entry': 'activate' }

async function settled() {
  await new Promise((r) => setTimeout(r, 10))
}

// ---------- 聚合口径：唯一出处，与面板总账同一份数法 ----------

test('聚合五档各不相同，且是人话不是相位英文', () => {
  const cases = [
    ['未查', null, 'idle', '检查更新'],
    ['空表', { rows: [], error: null }, 'idle', '检查更新'],
    ['可更新', { rows: [rowOf({ phase: 'ready' })], error: null }, 'update', '1 家可更新'],
    ['两家可更新', { rows: [rowOf({ key: 'a', phase: 'ready' }), rowOf({ key: 'b', phase: 'ready' })], error: null }, 'update', '2 家可更新'],
    ['安装中', { rows: [rowOf({ phase: 'installing' })], error: null }, 'busy', '正在安装…'],
    ['待重启', { rows: [rowOf({ phase: 'done', restartRequired: true })], error: null }, 'restart', '1 家待重启'],
    ['失败', { rows: [rowOf({ phase: 'failed', error: 'install-failed' })], error: null }, 'failed', '1 家失败，点此查看'],
    ['电话失败', { rows: null, error: 'check-failed' }, 'failed', '更新失败，点此查看'],
  ]
  for (const [name, state, kind, label] of cases) {
    assert.equal(batchEntryStateKind(state), kind, name)
    assert.equal(batchEntryLabelFor(state), label, name)
    assert.ok(!/pending|checking|ready|installing|failed/.test(batchEntryLabelFor(state).replace('失败', '')), name + ' 不许把相位英文露给用户')
  }
  assert.equal(batchEntryLabelFor(undefined), '检查更新', '没状态就当没查过')
})

test('失败优先级：失败排在待重启与可更新前面；忙仍最优先', () => {
  const mixed = [
    rowOf({ key: 'a', phase: 'ready' }),
    rowOf({ key: 'b', phase: 'done', restartRequired: true }),
    rowOf({ key: 'c', phase: 'failed', error: 'install-failed' }),
  ]
  assert.equal(batchEntryStateKind({ rows: mixed, error: null }), 'failed')
  assert.equal(batchEntryLabelFor({ rows: mixed, error: null }), '1 家失败，点此查看')
  const withBusy = [...mixed, rowOf({ key: 'd', phase: 'installing' })]
  assert.equal(batchEntryStateKind({ rows: withBusy, error: null }), 'busy')
  assert.equal(batchEntryLabelFor({ rows: withBusy, error: null }), '正在安装…')
})

test('忙失败占位翻回可更新：phase=failed + error=update-busy 不算失败（与面板总账同一口径）', () => {
  const rows = [rowOf({ phase: 'failed', error: 'update-busy' })]
  const s = batchEntrySummary({ rows, error: null })
  assert.equal(s.kind, 'update')
  assert.equal(s.label, '1 家可更新')
  assert.equal(s.updatable, 1)
  assert.equal(s.failed, 0)
})

// ---------- 默认形态：一个按钮，进来只读查一次全表 ----------

test('默认挂上就是一个按钮：挂载即静默调 .batchStatus（只读），文案即七家聚合', async () => {
  const rows = sevenRows()
  const { call, log } = fakeCall({ status: statusReply(rows) })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call, pollMs: 60000 })
  assert.match(box.innerHTML, /<button[^>]*data-dsh-upd-entry="activate"/, '挂上就是一个按钮')
  await settled()
  assert.deepEqual(log.map((e) => e.name), ['life.batchStatus'], 'autoCheck=mount 只调 .batchStatus（只读、不联网查新版）')
  // 七行里有 installing，聚合档为忙
  assert.match(box.innerHTML, /正在安装…/, '徽标即七家聚合（有安装中即忙）')
  assert.match(box.innerHTML, /data-state="busy"/, '状态如实带到 DOM 上')
  assert.equal(entry.label(), '正在安装…')
  const s = entry.summary()
  assert.equal(s.total, 7)
  assert.equal(s.installing, 1)
  assert.equal(s.failed, 1)
  assert.equal(s.restart, 1)
  assert.equal(s.updatable, 1)
  entry.unmount()
})

test('电话名只从批量前缀派生：传 life 就是 life.*', async () => {
  const { call, log } = fakeCall({ status: statusReply([]) })
  const entry = mountUpdateBatchEntry(fakeContainer(), { prefix: 'life', call, pollMs: 60000 })
  await entry.refresh()
  assert.ok(log.some((e) => e.name === 'life.batchStatus'), '前缀进电话名')
  entry.unmount()
})

test("autoCheck='never'：挂载不打电话，用户点击才调 .batchCheck", async () => {
  const rows = sevenRows()
  const { call, log } = fakeCall({ status: statusReply(rows), check: checkReply(rows) })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call, autoCheck: 'never', pollMs: 60000 })
  await settled()
  assert.deepEqual(log, [], 'never 就是挂载一条电话都不打')
  box.click(CLICK_ENTRY)
  await settled()
  assert.equal(log[0].name, 'life.batchCheck', '点击先查一次 N 家（之后面板自己的 batchStatus 是面板挂载即查）')
  assert.ok(!log.some((e) => e.name.endsWith('.batchInstall')), '查归查，装不许自动发生')
  entry.unmount()
})

// ---------- 点下去做什么：缺省 always 即开批量面板 ----------

test('缺省 openOn=always：点击先调 .batchCheck，再以 dialog 形态开批量面板（总管单行不再当状态源）', async () => {
  const rows = sevenRows()
  const { call, log } = fakeCall({ status: statusReply(rows), check: checkReply(rows) })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call, theme: 'archive', pollMs: 60000 })
  await settled()
  log.length = 0
  box.click(CLICK_ENTRY)
  await settled()
  assert.equal(log[0].name, 'life.batchCheck', '点击先查一次 N 家')
  assert.match(box.innerHTML, /dsh-upd-batch/, '点开即批量面板（复用 panel-batch，不是单面板）')
  assert.match(box.innerHTML, /data-mode="dialog"/, 'dialog 形态')
  assert.ok(!log.some((e) => e.name.endsWith('.batchInstall')), '开面板不等于装')
  entry.unmount()
})

test("openOn='has-update'：有事才开面板；确知没事只在原地给总账一句", async () => {
  const rows = [rowOf({ key: 'a', phase: 'ready' })]
  const { call, log } = fakeCall({ status: statusReply(rows), check: checkReply(rows) })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call, openOn: 'has-update', pollMs: 60000 })
  await settled()
  log.length = 0
  box.click(CLICK_ENTRY)
  await settled()
  assert.match(box.innerHTML, /dsh-upd-batch/, '有可更新即开批量面板')
  entry.unmount()

  const settledRows = [
    rowOf({ key: 'a', phase: 'current', snapshot: snapshotOf({ latestVersion: '1.0.0', canInstall: false }) }),
    rowOf({ key: 'b', phase: 'done', snapshot: snapshotOf({ latestVersion: '1.0.0', canInstall: false }) }),
  ]
  const c2 = fakeCall({ status: statusReply(settledRows), check: checkReply(settledRows) })
  const box2 = fakeContainer()
  const entry2 = mountUpdateBatchEntry(box2, { prefix: 'life', call: c2.call, openOn: 'has-update', pollMs: 60000 })
  await settled()
  box2.click(CLICK_ENTRY)
  await settled()
  assert.ok(!box2.innerHTML.includes('dsh-upd-batch'), '没事就不开面板')
  assert.match(box2.innerHTML, /已最新/, '原地给总账一句')
  assert.match(box2.innerHTML, /data-dsh-upd-entry="activate"/, '按钮还在，可以再查')
  entry2.unmount()
})

test("openOn='manual'：点击不开面板，改调 onActivate（聚合）——下游删桥接前后的对照口", async () => {
  const rows = sevenRows()
  const seen = []
  const { call } = fakeCall({ status: statusReply(rows), check: checkReply(rows) })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, {
    prefix: 'life', call, openOn: 'manual', onActivate: (s) => seen.push(s), pollMs: 60000,
  })
  await settled()
  box.click(CLICK_ENTRY)
  await settled()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].total, 7)
  assert.equal(seen[0].updatable, 1)
  assert.ok(!box.innerHTML.includes('dsh-upd-batch'), '接入方自己跳，入口件不开面板')
  entry.unmount()
})

// ---------- 另外两态：badge 与 inline ----------

test('variant=badge：只有一个小圆点，点击走 onActivate 不开面板', async () => {
  const rows = sevenRows()
  const seen = []
  const { call, log } = fakeCall({ status: statusReply(rows), check: checkReply(rows) })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, {
    prefix: 'life', call, variant: 'badge', onActivate: (s) => seen.push(s), pollMs: 60000,
  })
  await settled()
  assert.match(box.innerHTML, /data-variant="badge"/)
  assert.match(box.innerHTML, /dsh-upd-entry-dot/, '徽标只有一个小圆点')
  log.length = 0
  box.click(CLICK_ENTRY)
  await settled()
  assert.deepEqual(log.map((e) => e.name), ['life.batchCheck'], '点击照样先查一次')
  assert.equal(seen[0].total, 7)
  assert.ok(!box.innerHTML.includes('dsh-upd-batch'), '徽标不自己开面板')
  entry.unmount()
})

test('variant=inline：批量面板本体直接嵌进容器，不另画按钮', async () => {
  const rows = sevenRows()
  const { call } = fakeCall({ status: statusReply(rows) })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call, variant: 'inline', pollMs: 60000 })
  await settled()
  assert.match(box.innerHTML, /dsh-upd-batch/, '同一内核、内嵌摆放')
  assert.match(box.innerHTML, /data-mode="embedded"/, 'embedded 形态')
  assert.ok(!/<button[^>]*class="dsh-upd-entry-btn"/.test(box.innerHTML), 'inline 不另画按钮')
  assert.equal(entry.summary().total, 7)
  entry.unmount()
})

// ---------- 铁律：任何路径都不自动安装 ----------

test('铁律：三种形态整个生命周期里只打只读批量电话，绝不出现安装电话', async () => {
  for (const variant of ['button', 'badge', 'inline']) {
    const { call, log } = fakeCall({ status: statusReply(sevenRows()) })
    const box = fakeContainer()
    const entry = mountUpdateBatchEntry(box, {
      prefix: 'life', call, variant, onActivate: () => {}, pollMs: 60000,
    })
    await settled()
    box.click(CLICK_ENTRY)
    await settled()
    await entry.refresh()
    entry.open()
    await settled()
    entry.close()
    await settled()
    entry.unmount()
    await settled()
    const names = [...new Set(log.map((e) => e.name))]
    assert.ok(
      names.every((n) => n === 'life.batchStatus' || n === 'life.batchCheck'),
      variant + '：只许打只读批量电话，实际=' + JSON.stringify(names),
    )
    assert.ok(!log.some((e) => e.name.endsWith('.batchInstall')), variant + '：全生命周期不许自动安装')
  }
})

// ---------- 关与卸 ----------

test('close() 收起 dialog 并把按钮还原（聚合文案回来）', async () => {
  const rows = sevenRows()
  const { call } = fakeCall({ status: statusReply(rows) })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call, pollMs: 60000 })
  await settled()
  entry.open()
  assert.match(box.innerHTML, /dsh-upd-batch/, '开的是批量面板')
  entry.close()
  await settled()
  assert.ok(!box.innerHTML.includes('dsh-upd-batch'), 'close 即收起面板')
  assert.match(box.innerHTML, /data-dsh-upd-entry="activate"/, '按钮还原')
  entry.unmount()
})
