/**
 * tests/issue-238-first-install-stale-failure.test.mjs —— #238：单品面板进入时先渲染上一次失败账本。
 *
 * 现象（web profile，官方桌面运行时）：目标从未装过、盘上残留上一次 failed 任务时，进入页签
 * 第一帧就画「更新失败（install-failed）」当前失败横幅，冒充当前状态。修形：历史账本不得冒充
 * 当前失败；本会话新鲜失败（用户动作/锁存）仍照旧显示；在途任务进度照旧。
 *
 * 只测外部行为：纯函数 panelViewModel 的横幅与挂载后的 HTML，不刺探内部闭包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel, panelViewModel } from '../dist/panel.js'

/** 未装（首装）快照 + 盘上残留失败任务（target 从未成功过）。 */
function firstInstallSnapshot(overrides = {}) {
  return {
    runningVersion: null,
    installed: false,
    installedVersion: null,
    latestVersion: '0.3.80',
    canInstall: true,
    blockedReason: null,
    registered: null,
    identity: 'first-install',
    job: { id: 'job-old', state: 'failed', targetVersion: '0.3.80', message: 'install-failed', requestId: 'req-old' },
    ...overrides,
  }
}

function installedSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installed: true,
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    registered: true,
    identity: 'update',
    job: null,
    ...overrides,
  }
}

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

function view(snapshot, extra = {}) {
  return panelViewModel({ snapshot, manual: null, queue: baseQueue(), skippedLatest: false, lastError: null, ...extra })
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function fakeCall(script = {}) {
  const log = []
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.updateStatus')) {
      return { ok: true, snapshot: script.statusSnapshot ?? firstInstallSnapshot(), manual: null, receipt: null, queue: baseQueue() }
    }
    if (name.endsWith('.updateCheck')) {
      return { ok: true, snapshot: script.statusSnapshot ?? firstInstallSnapshot(), manual: null, receipt: { checkId: 'c1', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }
    }
    if (name.endsWith('.updateInstall')) {
      return script.install ?? { ok: true, snapshot: firstInstallSnapshot({ job: null }), manual: null }
    }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

async function settled(ms = 30) {
  await new Promise((r) => setTimeout(r, ms))
}

// ---------- 纯函数：历史账本 ≠ 当前失败 ----------

test('首装 + 盘上旧 failed 任务（无新鲜失败）→ 不画「更新失败」当前态，让位首装视图', () => {
  const v = view(firstInstallSnapshot())
  assert.notEqual(v.banner.kind, 'failed', '旧失败账本不许冒充当前失败，实际=' + v.banner.kind)
  assert.equal(v.banner.kind, 'update', '应让位首装横幅')
  assert.match(v.banner.title, /首次安装/, '首装文案应到达')
  assert.doesNotMatch(v.banner.title, /更新失败/)
  assert.equal(v.installEnabled, true, '首装按钮仍可点')
})

test('首装 + 盘上旧 interrupted 任务 → 同样只当历史，不画当前失败', () => {
  const snap = firstInstallSnapshot({ job: { id: 'job-x', state: 'interrupted', targetVersion: '0.3.80', message: 'installation-changed', requestId: 'r' } })
  const v = view(snap)
  assert.notEqual(v.banner.kind, 'failed')
  assert.equal(v.banner.kind, 'update')
})

test('已装 + 盘上 failed 任务 → 原有失败页不回归（真现状照旧显示）', () => {
  const snap = installedSnapshot({ job: { id: 'job-1', state: 'failed', targetVersion: '1.1.0', message: 'install-failed', requestId: 'r' } })
  const v = view(snap)
  assert.equal(v.banner.kind, 'failed', '已装目标的失败仍是当前现状')
  assert.match(v.banner.title, /更新失败/)
})

test('首装 + 本会话新鲜失败（锁存 lastError）→ 照旧显示失败，不被历史条款吞掉', () => {
  const v = view(firstInstallSnapshot(), { lastError: 'install-failed' })
  assert.equal(v.banner.kind, 'failed', '用户动作刚失败必须可见')
  assert.match(v.banner.title, /更新失败/)
})

test('首装 + 回包新鲜 errorKind → 照旧显示失败', () => {
  const v = view(firstInstallSnapshot(), { errorKind: 'install-failed' })
  assert.equal(v.banner.kind, 'failed')
})

test('首装 + 在途任务 → 进度照旧（不因历史条款弱化在途）', () => {
  const snap = firstInstallSnapshot({ job: { id: 'job-run', state: 'installing', targetVersion: '0.3.80', message: null, requestId: 'r' } })
  const v = view(snap)
  assert.equal(v.banner.kind, 'busy', '在途必须如实显示进度')
  assert.equal(v.installEnabled, false)
})

// ---------- 挂载：首帧与后续刷新都不铺旧失败 ----------

test('挂载首帧 = 首装 + 旧 failed 任务 → HTML 不出现失败横幅，第二轮刷新也不复活', async () => {
  const { call } = fakeCall({ statusSnapshot: firstInstallSnapshot() })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'dsh-bill-ilife', prefix: 'wf', call, pollMs: 60000 })
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '首帧不许画失败横幅')
  assert.doesNotMatch(box.innerHTML, /更新失败/, '首帧不许出现「更新失败」文案')
  assert.match(box.innerHTML, /class="dsh-upd-banner" data-kind="update"/, '应画首装/可安装横幅')
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '后续只读刷新也不许复活历史失败')
  panel.unmount()
})

test('挂载后用户点安装并失败 → 新鲜失败必须可见（不弱化）', async () => {
  const { call } = fakeCall({
    statusSnapshot: firstInstallSnapshot(),
    install: { ok: false, error: 'install-failed', errorKind: 'install-failed', manual: null },
  })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'dsh-bill-ilife', prefix: 'wf', call, pollMs: 60000 })
  await panel.refresh()
  await settled()
  await panel.act('install')
  await settled()
  assert.match(box.innerHTML, /class="dsh-upd-banner" data-kind="failed"/, '用户动作刚失败必须画失败横幅')
  assert.match(box.innerHTML, /更新失败/)
  panel.unmount()
})

