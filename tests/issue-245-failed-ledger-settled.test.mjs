/**
 * tests/issue-245-failed-ledger-settled.test.mjs —— #245：上一次失败任务已被后续版本验证取代。
 *
 * 现象：上一轮安装失败（job.state = failed，targetVersion = T），随后更新的版本已经确实生效
 * （磁盘装的与宿主在跑的同一版、已登记、且不低于 T），面板/入口件/日志态/复制诊断仍把那条
 * 历史账本渲染成「当前更新失败」。
 *
 * 本票口径（见票正文拍板结论）：
 * - 判据取严：安装失败/中断 + 目标版本合法 + installed === true + registered === true +
 *   installedVersion 与 runningVersion 同一版 + 两者都 >= 目标版本；任一未知/不满足即不结算。
 * - 已结算的旧失败只留一条中性历史行；当前失败面（横幅/最后手段/手工命令/04 卷宗/日志 error 态/
 *   复制诊断的 install-failed 当前码）一律不再由它驱动。
 * - 本会话新鲜失败（errorKind/lastError）照旧显示；账本（state.json/job）一个字不改。
 *
 * 只测外部行为：纯函数、公开渲染与挂载后的 HTML/复制内容，不刺探内部闭包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureSettledOf } from '../dist/shared/failure-settled.js'
import { mountUpdatePanel, panelViewModel, renderUpdatePanelHTML } from '../dist/panel.js'
import { entryStateKind } from '../dist/panel/entry.js'
import { installButtonViewModel } from '../dist/install-button.js'
import { createClientLogChannel } from '../dist/log/client-queue.js'

/** 已装在跑 1.2.0、失败那次的目标也是 1.2.0 —— 目标确实生效，账本只是历史。 */
function settledSnapshot(overrides = {}) {
  return {
    runningVersion: '1.2.0',
    installed: true,
    installedVersion: '1.2.0',
    latestVersion: '1.2.0',
    canInstall: false,
    blockedReason: null,
    registered: true,
    identity: 'up-to-date',
    job: {
      id: 'job-settled',
      state: 'failed',
      targetVersion: '1.2.0',
      message: 'install-failed: 宿主执行失败',
      requestId: 'req-settled',
    },
    ...overrides,
  }
}

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

function view(snapshot, extra = {}) {
  return panelViewModel({ snapshot, manual: null, queue: baseQueue(), skippedLatest: false, lastError: null, ...extra })
}

function renderInput(snapshot, extra = {}) {
  return {
    snapshot,
    manual: null,
    queue: baseQueue(),
    skippedLatest: false,
    lastError: null,
    mode: 'embedded',
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
    ...extra,
  }
}

function html(snapshot, extra = {}) {
  return renderUpdatePanelHTML(renderInput(snapshot, extra))
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

/** status 可给「raw 快照」或「整条回包」的数组，越界后重复最后一条。 */
function fakeCall(script = {}) {
  const log = []
  const statuses = Array.isArray(script.status) ? script.status : [script.status ?? settledSnapshot()]
  let statusIndex = 0
  const lastSnapshot = statuses[statuses.length - 1]
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.updateStatus')) {
      const entry = statuses[Math.min(statusIndex, statuses.length - 1)]
      statusIndex += 1
      if (entry && entry.ok === false) return entry
      return { ok: true, snapshot: entry, manual: null, receipt: null, queue: baseQueue() }
    }
    if (name.endsWith('.updateCheck')) {
      return { ok: true, snapshot: lastSnapshot, manual: null, receipt: { checkId: 'c1', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }
    }
    if (name.endsWith('.updateInstall')) {
      return script.install ?? { ok: true, snapshot: lastSnapshot, manual: null }
    }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

async function settled(ms = 30) {
  await new Promise((r) => setTimeout(r, ms))
}

function settledLines(text) {
  return text.match(/class="dsh-upd-settled"/g) ?? []
}

/** 注入用的假日志通道：攒着不发，flush 时把整批交进 batches（同 tests/panel-log.test.mjs 的桩）。 */
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

// ---------- 判据（纯函数，取严） ----------

test('失败目标已在运行的那一版被取代 → 结算为历史', () => {
  assert.equal(failureSettledOf(settledSnapshot()), true)
  assert.equal(
    failureSettledOf(settledSnapshot({ job: { id: 'j', state: 'interrupted', targetVersion: '1.2.0', message: null, requestId: null } })),
    true,
    'interrupted 与 failed 同权',
  )
})

test('生效的是比目标更高的版本 → 同样结算（更新只会往前走）', () => {
  const snap = settledSnapshot({ runningVersion: '2.0.0', installedVersion: '2.0.0', latestVersion: '2.0.0' })
  assert.equal(failureSettledOf(snap), true)
})

test('判据取严：任一未知/不满足都不结算', () => {
  const cases = {
    '未装（#238 首装）': { installed: false },
    '未登记 registered=false': { registered: false },
    '登记未知 registered=null': { registered: null },
    '运行版本未知': { runningVersion: null },
    '运行版本低于目标': { runningVersion: '1.1.9' },
    '磁盘版本低于目标': { installedVersion: '1.1.9' },
    '磁盘与运行不同版': { runningVersion: '1.2.1' },
    '目标版本非法': { job: { id: 'j', state: 'failed', targetVersion: '../1.2.0', message: null, requestId: null } },
    '目标版本缺失': { job: { id: 'j', state: 'failed', targetVersion: null, message: null, requestId: null } },
    '在途任务': { job: { id: 'j', state: 'installing', targetVersion: '1.2.0', message: null, requestId: null } },
    '成功终态': { job: { id: 'j', state: 'completed', targetVersion: '1.2.0', message: null, requestId: null } },
    '没有任务': { job: null },
  }
  for (const [name, over] of Object.entries(cases)) {
    assert.equal(failureSettledOf(settledSnapshot(over)), false, name)
  }
  assert.equal(failureSettledOf(null), false)
  assert.equal(failureSettledOf(undefined), false)
})

test('判定只读：不改写快照与失败账本（job 一个字不动）', () => {
  for (const snap of [
    settledSnapshot(),
    settledSnapshot({ installedVersion: '1.1.9', runningVersion: '1.1.9', latestVersion: '1.2.0', canInstall: true }),
  ]) {
    const before = JSON.parse(JSON.stringify(snap))
    failureSettledOf(snap)
    assert.deepEqual(snap, before, '判定前后快照/job 必须逐字一致')
  }
})

// ---------- 视图模型：当前失败面不再由旧账本驱动 ----------

test('结算后的面板不再画失败页；本会话新鲜失败仍照旧显示', () => {
  const v = view(settledSnapshot())
  assert.notEqual(v.banner.kind, 'failed', '旧账本不许冒充当前失败，实际=' + v.banner.kind)
  assert.doesNotMatch(v.banner.title, /更新失败/)

  const fresh = view(settledSnapshot(), { lastError: 'install-failed' })
  assert.equal(fresh.banner.kind, 'failed', '用户动作刚失败必须可见')
  const freshKind = view(settledSnapshot(), { errorKind: 'install-failed' })
  assert.equal(freshKind.banner.kind, 'failed', '回包 errorKind 必须可见')
})

test('结算后远端出现更高新版 → 面板说的是可更新，而不是旧失败', () => {
  const v = view(settledSnapshot({ latestVersion: '1.3.0', canInstall: true, identity: 'update' }))
  assert.equal(v.banner.kind, 'update')
})

// ---------- 渲染：一条中性历史行，无当前失败卷宗 ----------

test('结算后的正常帧：一条中性历史行，失败横幅与 04 卷宗都不出现', () => {
  const out = html(settledSnapshot())
  assert.doesNotMatch(out, /class="dsh-upd-banner" data-kind="failed"/, '不许画失败横幅')
  assert.doesNotMatch(out, /更新失败/)
  assert.equal(settledLines(out).length, 1, '恰好一条历史行')
  assert.match(out, /data-settled="1"/)
  assert.match(out, /install-failed/, '历史行如实带失败码')
  assert.match(out, /1\.2\.0/, '历史行如实带目标版本')
  assert.doesNotMatch(out, /证据已冻结/, '不再有失败卷宗')
})

test('结算 + 新鲜失败 → 仍是失败帧（历史行不吞当下证据）', () => {
  const out = html(settledSnapshot(), { lastError: 'install-failed' })
  assert.match(out, /class="dsh-upd-banner" data-kind="failed"/)
})

test('目标未生效（磁盘低于目标）→ 失败帧照旧', () => {
  const snap = settledSnapshot({ installedVersion: '1.1.9', runningVersion: '1.1.9', latestVersion: '1.2.0', canInstall: true })
  const out = html(snap)
  assert.match(out, /class="dsh-upd-banner" data-kind="failed"/)
  assert.equal(settledLines(out).length, 0)
})

test('真失败逐例：运行未知/低于目标、磁盘与运行不同版、未登记 → 失败帧照旧，不出历史行', () => {
  const cases = {
    '运行版本未知': { runningVersion: null },
    '运行版本低于目标': { runningVersion: '1.1.9' },
    '磁盘与运行不同版': { runningVersion: '1.2.1' },
    '未登记 registered=false': { registered: false },
    '登记未知 registered=null': { registered: null },
  }
  for (const [name, over] of Object.entries(cases)) {
    const snap = settledSnapshot(over)
    assert.equal(failureSettledOf(snap), false, name + '：不得结算')
    const out = html(snap)
    assert.match(out, /class="dsh-upd-banner" data-kind="failed"/, name + '：必须照旧画失败横幅')
    assert.equal(settledLines(out).length, 0, name + '：不许出现历史行')
  }
})

// ---------- 挂载：首帧/刷新/重挂/复制诊断 ----------

test('挂载首帧 = 已装 + 目标已生效的旧 failed 任务 → 无失败面，一条历史行', async () => {
  const { call } = fakeCall({ status: settledSnapshot() })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 'wf', call, pollMs: 60000 })
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '首帧不许画失败横幅')
  assert.doesNotMatch(box.innerHTML, /更新失败/)
  assert.equal(settledLines(box.innerHTML).length, 1, '一条中性历史行')
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '只读轮询不许复活历史失败')
  panel.unmount()
})

test('结算帧点「知道了」：同帧与后续轮询都不回到当前失败，历史行保留', async () => {
  const { call } = fakeCall({ status: settledSnapshot() })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p245-dismiss', prefix: 'wf', call, pollMs: 60000 })
  await panel.refresh()
  await settled()
  assert.equal(settledLines(box.innerHTML).length, 1)
  await panel.act('dismiss-failure')
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '点「知道了」不许把历史账本翻回当前失败（同帧）')
  assert.equal(settledLines(box.innerHTML).length, 1, '历史行不因「知道了」消失')
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '后续只读轮询也不许重建')
  panel.unmount()
})

test('卸载重挂：恢复的安装锁存被已了结快照解除，后续轮询不再重建', async () => {
  // 第一挂载：目标未生效的真失败（installed===true 但版本低于目标）→ 快照带 failed job，
  // 首刷按 latchFromJob 冻结一条 source='install' 的失败锁存（跨重挂存模块级表）。
  const broken = settledSnapshot({ installedVersion: '1.1.9', runningVersion: '1.1.9', latestVersion: '1.2.0', canInstall: true })
  const { call: callBroken } = fakeCall({ status: broken })
  const boxBroken = fakeContainer()
  const panelBroken = mountUpdatePanel(boxBroken, { pluginId: 'p245-remount', prefix: 'wf', call: callBroken, pollMs: 60000 })
  await panelBroken.refresh()
  await settled()
  assert.match(boxBroken.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '真失败先立住（这样重挂才有旧锁存可恢复）')
  panelBroken.unmount()

  // 第二挂载：同一 pluginId 会把上面那条安装锁存恢复回来（#58：失败证据跨重挂立即可见）。
  // #245 边界：恢复的那一帧仍按旧锁存画失败（#58 语义，不为本票改首帧）；首个成功回包带回
  // 「目标已生效」证据时就地解除，且之后的只读轮询不许重建。
  const { call: callSettled } = fakeCall({ status: settledSnapshot() })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p245-remount', prefix: 'wf', call: callSettled, pollMs: 60000 })
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '已了结快照必须解除恢复的安装锁存')
  assert.equal(settledLines(box.innerHTML).length, 1, '只留一条中性历史行')
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '后续只读轮询不许按旧 job 重建锁存')
  assert.equal(settledLines(box.innerHTML).length, 1)
  panel.unmount()
})

test('本会话失败可见后目标生效：成功轮询清除旧失败，历史行保留', async () => {
  // 失败阶段：一次刷新内部会补读若干次（#58），期间所有电话都失败，保证首帧确为失败；
  // 之后切到「目标已生效」阶段，成功轮询必须让位给当前事实。
  const failureReply = { ok: false, error: 'install-failed', errorKind: 'install-failed', manual: null }
  const okReply = () => ({ ok: true, snapshot: settledSnapshot(), manual: null, receipt: null, queue: baseQueue() })
  let repaired = false
  const call = async (name) => {
    if (name.endsWith('.updateStatus')) return repaired ? okReply() : failureReply
    if (name.endsWith('.updateCheck')) return repaired ? { ...okReply(), receipt: { checkId: 'c1', checkedAt: 1, expiresAt: 9 } } : failureReply
    throw new Error('unknown-phone:' + name)
  }
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 'wf', call, pollMs: 60000 })
  await panel.refresh()
  await settled()
  assert.match(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '第一次失败是新鲜证据，必须可见')
  repaired = true
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '目标版本已生效后旧失败让位')
  assert.equal(settledLines(box.innerHTML).length, 1)
  panel.unmount()
})

test('目标未生效的失败不会被成功轮询洗掉（真失败常驻）', async () => {
  const failureReply = { ok: false, error: 'install-failed', errorKind: 'install-failed', manual: null }
  const stillBroken = settledSnapshot({ installedVersion: '1.1.9', runningVersion: '1.1.9', latestVersion: '1.2.0', canInstall: true })
  const { call } = fakeCall({ status: [failureReply, stillBroken, stillBroken] })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 'wf', call, pollMs: 60000 })
  await panel.refresh()
  await settled()
  await panel.refresh()
  await settled()
  assert.match(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '目标不在跑，失败仍是现状')
  panel.unmount()
})

test('复制诊断不再把旧失败当当前码（给当前状态快照）', async () => {
  let copied = null
  const { call } = fakeCall({ status: settledSnapshot() })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    prefix: 'wf',
    call,
    pollMs: 60000,
    copyText: async (text) => { copied = text },
  })
  await panel.refresh()
  await settled()
  await panel.act('copy-diag')
  await settled()
  assert.ok(copied, '复制诊断必须有内容')
  assert.doesNotMatch(copied, /install-failed/, '旧失败码不许冒充当前失败码')
  assert.doesNotMatch(copied, /更新失败/)
  panel.unmount()
})

test('日志面板状态：已了结的旧失败不记 error 态；真失败仍记 error', async () => {
  // 已了结：状态行只该有 ready，不许出现 error（与横幅同一口径）。
  const first = logChannel()
  const { call: callSettled } = fakeCall({ status: settledSnapshot() })
  const settledPanel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p245-log-settled',
    prefix: 'wf',
    call: callSettled,
    pollMs: 60000,
    clientLog: { channel: first.ch },
  })
  await settledPanel.refresh()
  await settled()
  await first.ch.flush()
  const settledStates = rowsOf(first.batches)
    .filter((row) => row.event === 'update.panel.state')
    .map((row) => row.fields.state)
  assert.ok(settledStates.includes('ready'), '至少要有一行 ready，实际=' + settledStates.join(','))
  assert.ok(!settledStates.includes('error'), '已了结的旧失败不许记 error 态，实际=' + settledStates.join(','))
  settledPanel.unmount()

  // 真失败对照：目标未生效的 failed job 照旧记 error（证明上面的断言不是空转）。
  const second = logChannel()
  const broken = settledSnapshot({ installedVersion: '1.1.9', runningVersion: '1.1.9', latestVersion: '1.2.0', canInstall: true })
  const { call: callBroken } = fakeCall({ status: broken })
  const brokenPanel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p245-log-broken',
    prefix: 'wf',
    call: callBroken,
    pollMs: 60000,
    clientLog: { channel: second.ch },
  })
  await brokenPanel.refresh()
  await settled()
  await second.ch.flush()
  const brokenStates = rowsOf(second.batches)
    .filter((row) => row.event === 'update.panel.state')
    .map((row) => row.fields.state)
  assert.ok(brokenStates.includes('error'), '真失败仍记 error 态，实际=' + brokenStates.join(','))
  brokenPanel.unmount()
})

// ---------- 入口件与安装槽：状态档与视图同一口径 ----------

test('入口状态档：结算后的旧失败不再报 failed；新鲜 error 仍报 failed', () => {
  const snapshot = settledSnapshot({ latestVersion: '1.3.0', canInstall: true, identity: 'update' })
  assert.equal(entryStateKind({ snapshot, error: null }), 'update')
  assert.equal(entryStateKind({ snapshot, error: 'install-failed' }), 'failed')
})

test('安装槽视图：结算后的旧失败不再画失败页；新鲜失败仍画', () => {
  const base = {
    manual: null,
    queue: baseQueue(),
    lastError: null,
    errorKind: null,
    errorDetail: null,
    errorDiag: null,
    pluginId: 'p',
    fallbackOffer: null,
    busyAct: null,
    pollCapped: false,
    lang: 'zh',
  }
  const clean = installButtonViewModel({ ...base, snapshot: settledSnapshot() })
  assert.notEqual(clean.bannerKind, 'failed', '槽位不许画旧失败页')
  const fresh = installButtonViewModel({ ...base, snapshot: settledSnapshot(), lastError: 'install-failed' })
  assert.equal(fresh.bannerKind, 'failed', '槽位的新鲜失败仍可见')
})
