/**
 * tests/issue-243-auto-resume-stale.test.mjs —— #243 打开批量面板静默续跑两小时前旧会话。
 *
 * 只测外部行为：挂批量面板（假容器 + 假传输）→ 看 batchResume 有没有被调、面板有没有
 * 把「继续上次未完成的更新」交给用户点。铁律：点「检查更新」不是「自动继续装」；
 * 太旧的会话必须由用户显式继续。
 *
 * 现场（2026-10-20 16:41 web profile）：14:17 那轮留下的会话（age 2h18m）在用户点开面板时
 * 被 autoResume 直接续跑，一口气装了 7 家（5 成 2 败），用户全程不知道发生了什么。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdateBatchPanel } from '../dist/panel-batch.js'

const STALE_MS = 20 * 60 * 1000 // 明显超过 10 分钟门限
const FRESH_MS = 30 * 1000

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

/** 会话工厂：`updatedAt` 缺省时传 undefined 以模拟「老形状没有这个字段」。 */
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

const finishedSession = () => sessionOf({ updatedAt: 2, phases: ['done'] })

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

function clickAct(box, act) {
  const attrs = { 'data-act': act }
  const el = { getAttribute: (name) => (name in attrs ? attrs[name] : null) }
  const target = { closest: (sel) => (sel === '[data-act]' && attrs['data-act'] ? el : null) }
  for (const fn of [...box.listeners]) fn({ target })
}

const flush = async (n = 16) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 假传输：status 永远给同一份「未完成」会话；resume 成功后给收尾会话。
 * 记录每一次电话名，测试只看 batchResume 有没有被调用。
 */
function makeCall({ session, rows, resumeReply = null }) {
  const log = []
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.batchStatus')) return { ok: true, session, rows, progress: {}, inventory: null }
    if (name.endsWith('.batchResume')) {
      if (resumeReply) return resumeReply
      // 真宿主续跑回包：会话仍在、行还在装（剩余 >0 才会落「已自动继续…」提示）。
      return { ok: true, resumed: true, session, rows, progress: {} }
    }
    if (name.endsWith('.batchPrefs')) return { ok: true, prefs: {} }
    if (name.endsWith('.batchCheck')) return { ok: true, session, rows, progress: {} }
    if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log, resumes: () => log.filter((n) => n.endsWith('.batchResume')).length }
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

test('#243：超龄会话不自动续跑，留给用户点「继续上次未完成的更新」', async () => {
  const session = sessionOf({ updatedAt: Date.now() - STALE_MS })
  const script = makeCall({ session, rows: [rowOf()] })
  const { box, panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 0, '超龄会话绝不许静默续跑（实际调了 batchResume）')
  assert.match(box.innerHTML, /继续上次未完成的更新/, '必须把续跑按钮交给用户')
  assert.match(box.innerHTML, /上次更新未完成/, '必须提示这是上次没做完的一轮')

  // 用户显式点「继续」→ 这时才许真续跑。
  clickAct(box, 'resume')
  await flush()
  assert.equal(script.resumes(), 1, '用户点了继续，才该调 batchResume')
  panel.unmount()
})

test('#243：新鲜会话照旧「打开即续」（#59 D3/Q3 不回退）', async () => {
  const session = sessionOf({ updatedAt: Date.now() - FRESH_MS })
  const script = makeCall({ session, rows: [rowOf()] })
  const { box, panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 1, '10 分钟内的会话仍应自动继续一次')
  assert.match(box.innerHTML, /已自动继续上次未完成的更新/)
  panel.unmount()
})

test('#243：会话没有 updatedAt（老形状）→ 保持旧行为，不因缺字段改变语义', async () => {
  const session = sessionOf({ updatedAt: undefined })
  const script = makeCall({ session, rows: [rowOf()] })
  const { panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 1, '读不到新鲜度时保持旧行为（自动续跑）')
  panel.unmount()
})

test('#243：没有未完成行 → 既不续跑也不提示', async () => {
  const session = sessionOf({ updatedAt: Date.now() - STALE_MS, phases: ['done'] })
  const script = makeCall({ session, rows: [rowOf({ phase: 'done' })] })
  const { box, panel } = mountWith(script)
  await flush()
  assert.equal(script.resumes(), 0)
  assert.doesNotMatch(box.innerHTML, /上次更新未完成/)
  panel.unmount()
})
