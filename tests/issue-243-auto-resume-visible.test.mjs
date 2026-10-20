/**
 * tests/issue-243-auto-resume-visible.test.mjs —— #243 自动续跑：保留行为，但必须可见。
 *
 * 2026-10-20 产品拍板：打开面板自动续跑上次没跑完的批次是**设计行为**，不再按会话年龄设门限
 * （真实宿主里检查对账会刷新 session.updatedAt，年龄门限永远读到「刚活动过」）。
 * 取而代之的不变量是「可见」：续跑开始先落一条「正在继续」回执，用户始终知道它在干什么。
 *
 * 本文件只测外部行为：挂批量面板（假容器 + 假传输），看 batchResume 有没有被调、
 * 面板有没有先出现「正在继续」、结束后有没有明确回执。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdateBatchPanel } from '../dist/panel-batch.js'

const STALE_MS = 20 * 60 * 1000

function snapshotOf(overrides = {}) {
  return {
    runningVersion: '0.3.80',
    installedVersion: '0.3.80',
    latestVersion: '0.3.81',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function rowOf(overrides = {}) {
  return {
    key: 'bill',
    title: '饼干记账',
    phase: 'installing',
    targetVersion: '0.3.81',
    restartRequired: false,
    error: null,
    snapshot: snapshotOf(),
    manual: null,
    queue: null,
    profileName: null,
    pluginId: 'dsh-bill-ilife',
    phoneNames: { updateCheck: 'bill.updateCheck', updateInstall: 'bill.updateInstall' },
    ...overrides,
  }
}

/** 会话工厂：updatedAt 缺省时传 undefined 以模拟「老形状没有这个字段」。 */
function sessionOf({ updatedAt = undefined, phases = ['installing'] } = {}) {
  const entries = phases.map((phase, at) => ({
    key: 'bill',
    phase,
    requestId: 'batch:s:bill',
    targetVersion: '0.3.81',
    restartRequired: false,
    error: null,
    updatedAt: at + 1,
  }))
  const base = {
    version: 1,
    id: 's-243',
    selfKey: null,
    stopOnFailure: false,
    order: ['bill'],
    entries,
    createdAt: 1,
  }
  return updatedAt === undefined ? base : { ...base, updatedAt }
}

function fakeContainer() {
  const listeners = []
  return {
    innerHTML: '',
    listeners,
    addEventListener(type, fn) {
      if (type === 'click') listeners.push(fn)
    },
    removeEventListener(type, fn) {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
}

const flush = async (n = 24) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 假传输：status 永远给同一份「未完成」会话；resume 可以被挂起（deferred）以观察中间态。
 * @param {{ session, rows, resumeReply?, holdResume?: boolean }} script
 */
function makeCall(script) {
  const log = []
  let release = null
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.batchStatus')) return { ok: true, session: script.session, rows: script.rows, progress: {}, inventory: null }
    if (name.endsWith('.batchResume')) {
      if (script.holdResume) {
        return await new Promise((resolve) => {
          release = () => resolve(script.resumeReply ?? { ok: true, resumed: true, session: script.session, rows: script.rows, progress: {} })
        })
      }
      return script.resumeReply ?? { ok: true, resumed: true, session: script.session, rows: script.rows, progress: {} }
    }
    if (name.endsWith('.batchPrefs')) return { ok: true, prefs: {} }
    if (name.endsWith('.batchCheck')) return { ok: true, session: script.session, rows: script.rows, progress: {} }
    if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
    throw new Error('unknown-phone:' + name)
  }
  return {
    call,
    log,
    resumes: () => log.filter((n) => n.endsWith('.batchResume')).length,
    release: () => release && release(),
  }
}

function mountWith(script) {
  const box = fakeContainer()
  const panel = mountUpdateBatchPanel(box, {
    prefix: 'life',
    call: script.call,
    pollMs: 60000,
    checkOnOpen: false,
  })
  return { box, panel }
}

test('#243：旧会话（20 分钟前）也自动续跑——这是设计行为，不再按年龄拦', async () => {
  const session = sessionOf({ updatedAt: Date.now() - STALE_MS })
  const script = makeCall({ session, rows: [rowOf()] })
  const { panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 1, '旧会话同样自动续跑（#243 的年龄门限已按产品决定移除）')
  panel.unmount()
})

test('#243：续跑开始先落「正在继续」可见回执（不静默）', async () => {
  const session = sessionOf({ updatedAt: Date.now() - STALE_MS })
  const script = makeCall({
    session,
    rows: [rowOf()],
    holdResume: true,
    resumeReply: { ok: true, resumed: true, session, rows: [rowOf()], progress: {} },
  })
  const { box, panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 1, '应已发起续跑')
  assert.match(box.innerHTML, /正在继续/, '续跑期间面板必须明说「正在继续」，不许静默安装')
  script.release()
  await flush()
  panel.unmount()
})

test('#243：续跑结束、剩余未完成 >0 → 报「已自动继续…（剩余 N 个）」', async () => {
  const session = sessionOf({ updatedAt: Date.now() - STALE_MS })
  const resumeReply = { ok: true, resumed: true, session, rows: [rowOf()], progress: {} }
  const script = makeCall({ session, rows: [rowOf()], resumeReply })
  const { box, panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 1)
  assert.match(box.innerHTML, /已自动继续上次未完成的更新/)
  panel.unmount()
})

test('#243：续跑结束、全部收尾 → 报「上次未完成的更新已全部完成」', async () => {
  const session = sessionOf({ updatedAt: Date.now() - STALE_MS })
  const doneSession = sessionOf({ updatedAt: Date.now(), phases: ['done'] })
  const resumeReply = { ok: true, resumed: true, session: doneSession, rows: [rowOf({ phase: 'done' })], progress: {} }
  const script = makeCall({ session, rows: [rowOf()], resumeReply })
  const { box, panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 1)
  assert.match(box.innerHTML, /上次未完成的更新已全部完成/)
  panel.unmount()
})

test('#243：没有未完成行 → 不续跑也不提示', async () => {
  const session = sessionOf({ updatedAt: Date.now() - STALE_MS, phases: ['done'] })
  const script = makeCall({ session, rows: [rowOf({ phase: 'done' })] })
  const { box, panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 0)
  assert.doesNotMatch(box.innerHTML, /正在继续/)
  panel.unmount()
})
