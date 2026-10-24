/**
 * tests/hub-snapshot.test.mjs —— 更新中枢 T1：全局快照是纯投影（issue #247 的一部分）。
 *
 * 黑盒视角回答一个问题：盘上有一份方案、一份批量账本、一份检查知识，任意一个存活的集成方
 * 能不能不依赖「发起更新的那个插件还活着」，就答出「全局进度长什么样」？
 *
 * 断言的是快照契约，不是中枢内部实现：状态（running/waiting/finished/missing）、行序、
 * 进度同口径、封顶与截断如实、坏来源逐条跳过且整体不抛。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createBatchSession, markBatchEntry } from '../dist/core/batch/model.js'
import { createHubPlan } from '../dist/core/hub/plan.js'
import {
  HUB_SNAPSHOT_MAX_ROWS_PER_SESSION,
  HUB_SNAPSHOT_VERSION,
  emptyHubSnapshot,
  hubSnapshotActiveCount,
  projectHubSnapshot,
} from '../dist/core/hub/snapshot.js'

const SCOPE = { homeDir: 'C:/home', profileDir: 'C:/home/.dsh/profiles/desktop', profileName: 'desktop' }

/** 三个目标、self 排第一（#219 的用户要求；快照必须原样体现行序）。 */
function planOf(overrides = {}) {
  return createHubPlan({
    sessionId: 's1',
    owner: 'life',
    targets: [
      { key: 'alpha', title: 'Alpha', packageName: '@x/alpha', pluginId: 'alpha', prefix: 'dsh-alpha' },
      { key: 'beta', title: 'Beta', packageName: '@x/beta', pluginId: 'beta', prefix: 'dsh-beta' },
      { key: 'self', title: 'Self', packageName: '@x/self', pluginId: 'self', prefix: 'dsh-self' },
    ],
    scope: SCOPE,
    selfKey: 'self',
    selfOrder: 'first',
    now: 1_000,
    ...overrides,
  })
}

/** 按方案造一份账本，把指定行改成指定相位。 */
function sessionOf(plan, phases = {}, now = 2_000, id = plan.sessionId) {
  let session = createBatchSession({
    id,
    keys: plan.targets.map((target) => target.key),
    selfKey: plan.selfKey,
    selfOrder: plan.selfOrder,
    stopOnFailure: plan.stopOnFailure,
    now,
  })
  for (const [key, phase] of Object.entries(phases)) {
    session = markBatchEntry(session, key, { phase }, now).session
  }
  return session
}

/** 只有一个目标的最小方案（排序类断言用）。 */
function singlePlan(sessionId, owner, now = 1_000) {
  return createHubPlan({
    sessionId,
    owner,
    targets: [{ key: 't', title: owner, packageName: '@x/' + owner, pluginId: 'p-' + owner, prefix: 'dsh-' + owner }],
    scope: SCOPE,
    now,
  })
}

describe('#247 中枢全局快照（纯投影）', () => {
  it('方案 + 账本 + 检查知识 → 等待态、行序按方案、进度同口径', () => {
    const plan = planOf()
    const session = sessionOf(plan, { alpha: 'done', beta: 'ready', self: 'pending' })
    const snapshot = projectHubSnapshot({
      at: 3_000,
      sources: [
        {
          plan,
          session,
          inventory: {
            version: 1,
            updatedAt: 2_500,
            entries: {
              beta: { lastCheckedAt: 2_400, installed: false, installedVersion: '1.0.0', latestVersion: '2.0.0', canInstall: true, error: null },
            },
          },
          installed: { alpha: '1.0.0' },
        },
      ],
    })
    assert.equal(snapshot.version, HUB_SNAPSHOT_VERSION)
    assert.equal(snapshot.at, 3_000)
    assert.equal(snapshot.sessions.length, 1)
    const [view] = snapshot.sessions
    assert.equal(view.sessionId, 's1')
    assert.equal(view.owner, 'life')
    assert.equal(view.selfKey, 'self')
    assert.equal(view.state, 'waiting')
    assert.deepEqual(view.rows.map((row) => row.key), ['self', 'alpha', 'beta'])
    assert.deepEqual(view.progress, { total: 3, done: 1, failed: 0, skipped: 0, current: 1, pending: 1, finished: false })
    const self = view.rows[0]
    assert.equal(self.phase, 'pending')
    const alpha = view.rows[1]
    assert.equal(alpha.installedVersion, '1.0.0')
    const beta = view.rows[2]
    assert.equal(beta.installedVersion, '1.0.0')
    assert.equal(beta.latestVersion, '2.0.0')
    assert.equal(snapshot.sessionsTotal, 1)
    assert.equal(snapshot.sessionsTruncated, false)
  })

  it('有行在查/在装 → 进行中；所有行收尾 → 已收尾（失败也算收尾）', () => {
    const plan = planOf()
    const running = projectHubSnapshot({ at: 1, sources: [{ plan, session: sessionOf(plan, { beta: 'installing' }) }] })
    assert.equal(running.sessions[0].state, 'running')
    const finished = projectHubSnapshot({
      at: 1,
      sources: [{ plan, session: sessionOf(plan, { alpha: 'done', beta: 'failed', self: 'current' }) }],
    })
    assert.equal(finished.sessions[0].state, 'finished')
    assert.deepEqual(finished.sessions[0].progress, { total: 3, done: 2, failed: 1, skipped: 0, current: 0, pending: 0, finished: true })
  })

  it('队列里正装着它家的目标 → 也算进行中；别家的安装不算', () => {
    const plan = planOf()
    const session = sessionOf(plan, {})
    const own = projectHubSnapshot({ at: 1, sources: [{ plan, session }], activeInstall: { pluginId: 'beta', startedAt: 9 } })
    assert.equal(own.sessions[0].state, 'running')
    assert.deepEqual(own.activeInstall, { pluginId: 'beta', startedAt: 9 })
    const foreign = projectHubSnapshot({ at: 1, sources: [{ plan, session }], activeInstall: { pluginId: 'unrelated', startedAt: 9 } })
    assert.equal(foreign.sessions[0].state, 'waiting')
    const bad = projectHubSnapshot({ at: 1, sources: [{ plan, session }], activeInstall: { pluginId: '' } })
    assert.equal(bad.activeInstall, null)
  })

  it('账本读不出来/编号对不上 → 记录缺失，但方案的行仍然列出来', () => {
    const plan = planOf()
    const withoutSession = projectHubSnapshot({ at: 1, sources: [{ plan }] })
    assert.equal(withoutSession.sessions[0].state, 'missing')
    assert.equal(withoutSession.sessions[0].rows.length, 3)
    assert.equal(withoutSession.sessions[0].rows[0].phase, 'pending')
    assert.equal(withoutSession.sessions[0].progress.total, 0)
    const mismatched = projectHubSnapshot({ at: 1, sources: [{ plan, session: sessionOf(plan, {}, 2_000, 'other') }] })
    assert.equal(mismatched.sessions[0].state, 'missing')
  })

  it('旧的无方案账本按会话顺序投影，标题退回键', () => {
    let session = createBatchSession({ id: 'old', keys: ['a', 'b'], now: 1 })
    session = markBatchEntry(session, 'a', { phase: 'done' }, 5).session
    const snapshot = projectHubSnapshot({ at: 1, sources: [{ session, owner: 'legacy' }] })
    const [view] = snapshot.sessions
    assert.equal(view.sessionId, 'old')
    assert.equal(view.owner, 'legacy')
    assert.equal(view.selfKey, null)
    assert.deepEqual(view.rows.map((row) => row.key), ['a', 'b'])
    assert.deepEqual(view.rows.map((row) => row.title), ['a', 'b'])
    assert.equal(view.state, 'waiting')
    assert.equal(view.progress.done, 1)
  })

  it('排序：进行中 → 等待 → 缺失 → 已收尾', () => {
    const runningPlan = singlePlan('r', 'running')
    const waitingPlan = singlePlan('w', 'waiting')
    const missingPlan = singlePlan('m', 'missing')
    const finishedPlan = singlePlan('f', 'finished')
    const snapshot = projectHubSnapshot({
      at: 9_000,
      sources: [
        { plan: finishedPlan, session: sessionOf(finishedPlan, { t: 'done' }) },
        { plan: waitingPlan, session: sessionOf(waitingPlan, {}) },
        { plan: missingPlan },
        { plan: runningPlan, session: sessionOf(runningPlan, { t: 'installing' }) },
      ],
    })
    assert.deepEqual(snapshot.sessions.map((view) => view.sessionId), ['r', 'w', 'm', 'f'])
  })

  it('封顶：会话数与行数截断并如实报告', () => {
    const plans = [singlePlan('a', 'aa'), singlePlan('b', 'bb'), singlePlan('c', 'cc')]
    const capped = projectHubSnapshot({
      at: 1,
      sources: plans.map((plan) => ({ plan, session: sessionOf(plan, {}) })),
      limits: { maxSessions: 2 },
    })
    assert.equal(capped.sessionsTotal, 3)
    assert.equal(capped.sessions.length, 2)
    assert.equal(capped.sessionsTruncated, true)

    const widePlan = createHubPlan({
      sessionId: 'wide',
      owner: 'wide',
      targets: [1, 2, 3, 4, 5].map((n) => ({ key: 'k' + n, title: 'T' + n, packageName: '@x/k' + n, pluginId: 'p' + n, prefix: 'dsh-k' + n })),
      scope: SCOPE,
      now: 1_000,
    })
    const rowsCapped = projectHubSnapshot({
      at: 1,
      sources: [{ plan: widePlan, session: sessionOf(widePlan, {}) }],
      limits: { maxRowsPerSession: 2 },
    })
    const [view] = rowsCapped.sessions
    assert.equal(view.rows.length, 2)
    assert.equal(view.rowsTotal, 5)
    assert.equal(view.rowsTruncated, true)
    assert.ok(HUB_SNAPSHOT_MAX_ROWS_PER_SESSION >= 2)
  })

  it('同一个会话号两份来源：有账本的优先于记录缺失', () => {
    const plan = planOf()
    const snapshot = projectHubSnapshot({ at: 1, sources: [{ plan }, { plan, session: sessionOf(plan, { alpha: 'done' }) }] })
    assert.equal(snapshot.sessionsTotal, 1)
    assert.equal(snapshot.sessions[0].state, 'waiting')
    assert.equal(snapshot.sessions[0].progress.done, 1)
  })

  it('坏来源/坏值当缺失处理，绝不抛', () => {
    const snapshot = projectHubSnapshot({
      at: 1,
      sources: [null, 42, 'x', {}, { plan: {} }, { session: 'nope' }, { plan: planOf(), session: { version: 1, id: 5 } }],
    })
    assert.equal(snapshot.sessions.length, 1)
    assert.equal(snapshot.sessions[0].state, 'missing')
    assert.equal(projectHubSnapshot(null).sessions.length, 0)
    assert.equal(projectHubSnapshot({ at: 'x', sources: 'nope' }).sessions.length, 0)
  })

  it('空快照与进行中计数是同一套口径', () => {
    assert.deepEqual(emptyHubSnapshot(500), {
      version: HUB_SNAPSHOT_VERSION,
      at: 500,
      sessions: [],
      sessionsTotal: 0,
      sessionsTruncated: false,
      activeInstall: null,
    })
    const plan = planOf()
    const snapshot = projectHubSnapshot({
      at: 1,
      sources: [
        { plan, session: sessionOf(plan, { beta: 'installing' }) },
        { plan: singlePlan('w', 'waiting'), session: sessionOf(singlePlan('w', 'waiting'), {}) },
        { plan: singlePlan('f', 'fin'), session: sessionOf(singlePlan('f', 'fin'), { t: 'done' }) },
      ],
    })
    assert.equal(hubSnapshotActiveCount(snapshot), 2)
    assert.equal(hubSnapshotActiveCount(null), 0)
    assert.equal(hubSnapshotActiveCount({}), 0)
  })
})
