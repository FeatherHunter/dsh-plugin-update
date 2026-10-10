/**
 * tests/panel-auto-check.test.mjs —— #48：进入面板自动查一次新版（#46 结论固化）。
 *
 * 只测外部行为：调了几次哪种电话、画了什么文案与进度，不刺探内部闭包变量与调用顺序细节。
 * 先例沿用 panel.test.mjs（伪传输计数 + 快照装配）与 panel-busy.test.mjs（慢网与卸载编排）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel, pendingAutoCheck } from '../dist/panel.js'

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

function fakeCall(script = {}) {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) {
      return (
        script.status ?? {
          ok: true,
          snapshot: baseSnapshot(),
          manual: null,
          receipt: null,
          queue: baseQueue(),
        }
      )
    }
    if (name.endsWith('.updateCheck')) {
      return (
        script.check ?? {
          ok: true,
          snapshot: baseSnapshot(),
          manual: null,
          receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 999 },
          queue: baseQueue(),
        }
      )
    }
    if (name.endsWith('.updateInstall')) {
      return script.install ?? { ok: true, snapshot: baseSnapshot({ job: null }), manual: null }
    }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

async function settled(ms = 20) {
  await new Promise((r) => setTimeout(r, ms))
}

// ---------- 纯函数 ----------

test('pendingAutoCheck 纯函数：仅 installing/verifying 与在途抑制', () => {
  assert.equal(pendingAutoCheck(null, null), false, '无活体快照不发起')
  assert.equal(pendingAutoCheck(baseSnapshot(), null), true, '正常快照发起')
  assert.equal(
    pendingAutoCheck(baseSnapshot({ job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' } }), null),
    false,
    '安装中不发起',
  )
  assert.equal(
    pendingAutoCheck(baseSnapshot({ job: { id: 'j', state: 'verifying', targetVersion: '1.1.0', message: null, requestId: 'r' } }), null),
    false,
    '校验中不发起',
  )
  for (const st of ['failed', 'completed', 'restart-required', 'interrupted']) {
    assert.equal(
      pendingAutoCheck(baseSnapshot({ job: { id: 'j', state: st, targetVersion: '1.1.0', message: null, requestId: 'r' } }), null),
      true,
      st + ' 仍发起',
    )
  }
  assert.equal(pendingAutoCheck(baseSnapshot(), 'check'), false, '已有查在途不发起')
  assert.equal(pendingAutoCheck(baseSnapshot(), 'install'), false, '已有装在途不发起')
  // 同范围忙、凭证过期、各类阻拦一律不抑制：快照侧只看 job state，blocked 照发起
  assert.equal(pendingAutoCheck(baseSnapshot({ canInstall: false, blockedReason: 'pending-restart' }), null), true, '待重启阻拦仍发起')
  assert.equal(pendingAutoCheck(baseSnapshot({ canInstall: false, blockedReason: 'incompatible-node' }), null), true, 'Node 不兼容仍发起')
  assert.equal(pendingAutoCheck(baseSnapshot({ latestVersion: null, canInstall: false }), null), true, '没远端仍发起（正是要去问远端）')
})

// ---------- 正常 mount 查一次 ----------

test('正常 mount：status 后自动查一次，远端版本一次可见', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await settled()
  await settled()
  const statusHits = log.filter((e) => e.name.endsWith('.updateStatus')).length
  const checkHits = log.filter((e) => e.name.endsWith('.updateCheck')).length
  assert.equal(statusHits, 1, '首个只读刷新一次，实际=' + JSON.stringify(log.map((e) => e.name)))
  assert.equal(checkHits, 1, 'mount 自动查一次，实际=' + JSON.stringify(log.map((e) => e.name)))
  assert.match(box.innerHTML, /1\.1\.0/, '远端版本号一次可见')
  panel.unmount()
})

// ---------- 安装在途不查 ----------

test('安装在途 mount 不查：只显示进度，不打 check 电话', async () => {
  const installing = baseSnapshot({
    latestVersion: null,
    canInstall: false,
    job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' },
  })
  const { call, log } = fakeCall({
    status: { ok: true, snapshot: installing, manual: null, receipt: null, queue: baseQueue() },
  })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await settled()
  await settled()
  assert.equal(log.filter((e) => e.name.endsWith('.updateCheck')).length, 0, '安装中不自动查')
  assert.ok(log.some((e) => e.name.endsWith('.updateStatus')), '只读刷新仍发生')
  assert.match(box.innerHTML, /正在安装/, '只显示安装进度')
  panel.unmount()
})

test('校验中 mount 也不查', async () => {
  const verifying = baseSnapshot({
    latestVersion: null,
    canInstall: false,
    job: { id: 'j', state: 'verifying', targetVersion: '1.1.0', message: null, requestId: 'r' },
  })
  const { call, log } = fakeCall({
    status: { ok: true, snapshot: verifying, manual: null, receipt: null, queue: baseQueue() },
  })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await settled()
  await settled()
  assert.equal(log.filter((e) => e.name.endsWith('.updateCheck')).length, 0)
  panel.unmount()
})

// ---------- 阻拦仍查 ----------

test('被阻拦仍自动查：待重启与 Node 不兼容不抑制', async () => {
  for (const blockedReason of ['pending-restart', 'incompatible-node']) {
    const blocked = baseSnapshot({ canInstall: false, blockedReason, latestVersion: null })
    const { call, log } = fakeCall({
      status: { ok: true, snapshot: blocked, manual: null, receipt: null, queue: baseQueue() },
      check: { ok: true, snapshot: baseSnapshot({ canInstall: false, blockedReason, latestVersion: '1.1.0' }), manual: null, receipt: null, queue: baseQueue() },
    })
    const box = fakeContainer()
    const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
    await settled()
    await settled()
    assert.equal(log.filter((e) => e.name.endsWith('.updateCheck')).length, 1, blockedReason + ' 应仍自动查')
    panel.unmount()
  }
})

// ---------- 慢网不双发 ----------

test('慢网不双发：自动查在途时手动点不另发，只认一次', async () => {
  const calls = []
  const resolvers = []
  const call = async (name) => {
    calls.push(name)
    if (name.endsWith('.updateStatus')) {
      return { ok: true, snapshot: baseSnapshot({ latestVersion: null }), manual: null, receipt: null, queue: baseQueue() }
    }
    if (name.endsWith('.updateCheck')) {
      // 慢网：挂起，由测试稍后放行
      await new Promise((res) => resolvers.push(res))
      return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'c-slow', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }
    }
    throw new Error('unknown-phone:' + name)
  }
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000 })
  await settled()
  await settled()
  // 此时自动查应在途（status 已回，check 挂起）
  assert.equal(calls.filter((c) => c.endsWith('.updateCheck')).length, 1, '自动查已发出一次')
  assert.match(box.innerHTML, /正在查新版/, '在途提示复用手动同一文案')
  // 手动连点不应双发
  await panel.act('check')
  await panel.act('check')
  await settled(10)
  assert.equal(calls.filter((c) => c.endsWith('.updateCheck')).length, 1, '在途中的手动点不许再发')
  // 放行慢网回包
  resolvers.forEach((r) => r())
  await settled()
  await settled()
  assert.match(box.innerHTML, /1\.1\.0/, '慢网回包落到界面')
  panel.unmount()
})

// ---------- 卸载丢弃 ----------

test('卸载丢弃过期回包：在飞的自动查回来不写已拆的面板', async () => {
  let releaseCheck = null
  const waiting = new Promise((res) => {
    releaseCheck = res
  })
  const log = []
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.updateStatus')) return { ok: true, snapshot: baseSnapshot({ latestVersion: null }), manual: null, receipt: null, queue: baseQueue() }
    if (name.endsWith('.updateCheck')) return waiting.then(() => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'c-late', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }))
    throw new Error('unknown-phone:' + name)
  }
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000 })
  await settled()
  await settled()
  assert.equal(log.filter((n) => n.endsWith('.updateCheck')).length, 1, '自动查已在飞')
  const htmlBefore = box.innerHTML
  panel.unmount()
  releaseCheck()
  await settled()
  await settled()
  assert.equal(box.innerHTML, htmlBefore, '过期回包必须丢弃，不写已拆面板')
})

// ---------- 手动仍立即重问 ----------

test('手动查仍立即重问：自动成功后手动再查仍发电话', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await settled()
  await settled()
  assert.equal(log.filter((e) => e.name.endsWith('.updateCheck')).length, 1, '先有自动一次')
  await panel.act('check')
  await settled(10)
  assert.equal(log.filter((e) => e.name.endsWith('.updateCheck')).length, 2, '手动永远立即重问，不被静默压住')
  panel.unmount()
})

// ---------- 轮询永不查 ----------

test('轮询永不查新版：后续 refresh 只读本地', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await settled()
  await settled()
  assert.equal(log.filter((e) => e.name.endsWith('.updateCheck')).length, 1)
  log.length = 0
  await panel.refresh()
  await settled(10)
  assert.equal(log.filter((e) => e.name.endsWith('.updateCheck')).length, 0, '轮询只调 status，不跟查')
  assert.ok(log.some((e) => e.name.endsWith('.updateStatus')), '轮询仍读本地')
  panel.unmount()
})

// ---------- 失败无退避 ----------

test('失败无退避：自动查失败渲染一句话，手动可立即重问', async () => {
  let checkN = 0
  const log = []
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.updateStatus')) return { ok: true, snapshot: baseSnapshot({ latestVersion: null }), manual: null, receipt: null, queue: baseQueue() }
    if (name.endsWith('.updateCheck')) {
      checkN++
      if (checkN === 1) return { ok: false, error: 'check-failed', errorKind: 'check-failed' }
      return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'c2', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }
    }
    throw new Error('unknown-phone:' + name)
  }
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000 })
  await settled()
  await settled()
  assert.match(box.innerHTML, /版本信息查询失败/, '失败即渲染既有一句话')
  assert.match(box.innerHTML, /复制诊断/, '失败带复制诊断入口')
  await panel.act('check')
  await settled()
  await settled()
  assert.match(box.innerHTML, /1\.1\.0/, '手动立即重问可恢复')
  panel.unmount()
})

// ---------- 安装复用自动凭证 ----------

test('安装复用自动凭证：mount 已拿凭证后安装不另查', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await settled()
  await settled()
  assert.ok(log.some((e) => e.name.endsWith('.updateCheck')), 'mount 应已自动查拿凭证')
  log.length = 0
  await panel.act('install')
  const checkAt = log.findIndex((e) => e.name.endsWith('.updateCheck'))
  const installAt = log.findIndex((e) => e.name.endsWith('.updateInstall'))
  assert.equal(checkAt, -1, '已有凭证时安装不另查，直接复用')
  assert.ok(installAt >= 0, '安装电话已发出')
  assert.equal(log[installAt].args.checkId, 'check-1', '复用自动查的凭证')
  panel.unmount()
})
