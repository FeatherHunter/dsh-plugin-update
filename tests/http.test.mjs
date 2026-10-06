/**
 * tests/http.test.mjs —— 单插件 HTTP 传输（#32）+ 批量五电话统一传输（#35，同一内核）。
 *
 * 只测外部行为：经公开的电话名与回包形状与面板/入口控制器断言，不拆传输内部变量。
 * 传输用内存假抓取，不真联网；超时那条把时限调极小，用短延时驱动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHttpCall, mountUpdatePanelHttp, mountUpdateEntryHttp, mountUpdateBatchPanelHttp } from '../dist/http.js'

function baseSnapshot(overrides) {
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

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function stubFetch(handler) {
  const log = []
  const fetch = async (url, init) => {
    log.push({ url, init })
    return handler(url, init, log)
  }
  return { fetch, log }
}

function okJson(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  }
}

// ---------- phone→path：三电话默认拼接 ----------

test('phone→path：三电话默认走 baseUrl/全电话名', async () => {
  const { fetch, log } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot() }))
  const call = createHttpCall({ prefix: 'demo', baseUrl: 'https://host.local:3000/upd', fetch })
  await call('demo.updateStatus', {})
  await call('demo.updateCheck', {})
  await call('demo.updateInstall', { checkId: 'c', requestId: 'r' })
  assert.deepEqual(
    log.map((e) => e.url),
    [
      'https://host.local:3000/upd/demo.updateStatus',
      'https://host.local:3000/upd/demo.updateCheck',
      'https://host.local:3000/upd/demo.updateInstall',
    ],
  )
  assert.equal(log[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(log[2].init.body), { checkId: 'c', requestId: 'r' })
})

test('斜杠归一：baseUrl 尾斜杠不产生双斜杠', async () => {
  const { fetch, log } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot() }))
  const call = createHttpCall({ prefix: 'demo', baseUrl: 'https://host.local:3000/upd///', fetch })
  await call('demo.updateCheck', {})
  assert.equal(log[0].url, 'https://host.local:3000/upd/demo.updateCheck')
})

test('缺键回落 + routes 优先：电话级逐键覆写', async () => {
  const { fetch, log } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot() }))
  const call = createHttpCall({
    prefix: 'demo',
    baseUrl: 'https://host.local:3000/upd',
    routes: { 'demo.updateInstall': 'https://dedicated.local/install' },
    fetch,
  })
  await call('demo.updateStatus', {})
  await call('demo.updateInstall', {})
  assert.equal(log[0].url, 'https://host.local:3000/upd/demo.updateStatus')
  assert.equal(log[1].url, 'https://dedicated.local/install')
})

test('routes 短键与相对路径：短动作键可用，相对拼 baseUrl', async () => {
  const { fetch, log } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot() }))
  const call = createHttpCall({
    prefix: 'demo',
    baseUrl: 'https://host.local:3000/upd',
    routes: { updateCheck: '/custom-check' },
    fetch,
  })
  await call('demo.updateCheck', {})
  assert.equal(log[0].url, 'https://host.local:3000/upd/custom-check')
})

test('routes 未知键拒绝：创建即抛', () => {
  assert.throws(
    () =>
      createHttpCall({
        prefix: 'demo',
        baseUrl: 'https://host.local:3000/upd',
        routes: { 'demo.nope': 'https://x.local/y' },
        fetch: async () => okJson({}),
      }),
    /未知键/,
  )
})

// ---------- 回包透传：queue/env/diag 不丢键 ----------

test('成功回包 queue/env 全透传：helper 不裁剪', async () => {
  const queue = { busy: true, position: 1, showOthers: true }
  const env = { hostKind: 'cli', profileName: 'web' }
  const { fetch } = stubFetch(async () =>
    okJson({ ok: true, snapshot: baseSnapshot(), manual: 'cmd', receipt: null, queue, env }),
  )
  const call = createHttpCall({ prefix: 'demo', baseUrl: 'https://h.local/u', fetch })
  const reply = await call('demo.updateStatus', { includeQueue: true, includeEnv: true, showOthers: true })
  assert.deepEqual(reply.queue, queue)
  assert.deepEqual(reply.env, env)
  assert.deepEqual(reply.snapshot, baseSnapshot())
})

test('失败 diag 透传不丢键：16 键保留，diagnostic 原话丢弃', async () => {
  const diag = {
    v: 1, stage: 'exec', route: 'cli-process', method: 'spawn', exitCode: 1,
    detail: '  失败了  ',
    requestId: 'req-3', extraKey: 'should-be-ignored',
  }
  const { fetch } = stubFetch(async () =>
    okJson({ ok: false, error: 'install-failed', errorKind: 'install-failed', diag, diagnostic: '原始堆栈不能外泄' }),
  )
  const call = createHttpCall({ prefix: 'demo', baseUrl: 'https://h.local/u', fetch })
  const reply = await call('demo.updateInstall', { checkId: 'c', requestId: 'req-3' })
  assert.equal(reply.error, 'install-failed')
  assert.ok(reply.diag, 'diag 应透传')
  assert.equal(reply.diag.stage, 'exec')
  assert.equal(reply.diag.requestId, 'req-3')
  assert.ok(!('extraKey' in (reply.diag ?? {})), 'diag 未知键应忽略')
  assert.ok(!('diagnostic' in reply), 'diagnostic 原话必须丢弃')
})

// ---------- 传输失败走异常通道，不占 14 码 ----------

test('传输失败：断网抛 http-transport-failed', async () => {
  const { fetch } = stubFetch(async () => {
    throw new Error('fetch failed')
  })
  const call = createHttpCall({ prefix: 'demo', baseUrl: 'https://h.local/u', fetch })
  await assert.rejects(call('demo.updateCheck', {}), (e) => {
    assert.equal(e.code, 'http-transport-failed')
    assert.equal(typeof e.detail, 'string')
    return true
  })
})

test('传输失败：非 2xx 抛 http-transport-failed', async () => {
  const { fetch } = stubFetch(async () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' }))
  const call = createHttpCall({ prefix: 'demo', baseUrl: 'https://h.local/u', fetch })
  await assert.rejects(call('demo.updateCheck', {}), (e) => {
    assert.equal(e.code, 'http-transport-failed')
    return true
  })
})

test('传输失败：非法 JSON 抛 http-transport-failed', async () => {
  const { fetch } = stubFetch(async () => ({ ok: true, status: 200, text: async () => '{not-json' }))
  const call = createHttpCall({ prefix: 'demo', baseUrl: 'https://h.local/u', fetch })
  await assert.rejects(call('demo.updateCheck', {}), (e) => {
    assert.equal(e.code, 'http-transport-failed')
    return true
  })
})

test('超时可覆写：极小时限触发传输失败', async () => {
  const { fetch } = stubFetch(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(okJson({ ok: true, snapshot: baseSnapshot() })), 200)
      }),
  )
  const call = createHttpCall({
    prefix: 'demo',
    baseUrl: 'https://h.local/u',
    fetch,
    timeout: { checkMs: 10 },
  })
  await assert.rejects(call('demo.updateCheck', {}), (e) => {
    assert.equal(e.code, 'http-transport-failed')
    return true
  })
})

// ---------- poll 下限：与直调同文案同步抛 ----------

test('poll 下限：mountUpdatePanelHttp 低于 250ms 与直调同文案抛错', async () => {
  const { fetch } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot() }))
  assert.throws(
    () =>
      mountUpdatePanelHttp(fakeContainer(), {
        pluginId: 'p',
        prefix: 'demo',
        baseUrl: 'https://h.local/u',
        fetch,
        pollMs: 100,
      }),
    /250/,
  )
})

test('poll 下限：mountUpdateEntryHttp 同样守下限', async () => {
  const { fetch } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot() }))
  assert.throws(
    () =>
      mountUpdateEntryHttp(fakeContainer(), {
        pluginId: 'p',
        prefix: 'demo',
        baseUrl: 'https://h.local/u',
        fetch,
        pollMs: 100,
      }),
    /250/,
  )
})

// ---------- 薄封装：面板/入口直挂注入既有内核 ----------

test('面板直挂：经 HTTP 跑通 status 与 check，电话名与面板一致', async () => {
  const seen = []
  const { fetch } = stubFetch(async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) })
    return okJson({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null })
  })
  const box = fakeContainer()
  const panel = mountUpdatePanelHttp(box, {
    pluginId: 'p',
    prefix: 'demo',
    baseUrl: 'https://h.local/u',
    fetch,
    pollMs: 60000,
  })
  await panel.refresh()
  await panel.act('check')
  assert.ok(seen.some((s) => s.url === 'https://h.local/u/demo.updateStatus'))
  assert.ok(seen.some((s) => s.url === 'https://h.local/u/demo.updateCheck'))
  assert.equal(seen[0].body.includeQueue, true)
  panel.unmount()
})

test('入口直挂：生命周期永不打出安装电话', async () => {
  const { fetch, log } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot({ latestVersion: '1.0.0', canInstall: false }) }))
  const box = { innerHTML: '', addEventListener() {}, removeEventListener() {} }
  const entry = mountUpdateEntryHttp(box, {
    pluginId: 'p',
    prefix: 'demo',
    baseUrl: 'https://h.local/u',
    fetch,
    pollMs: 60000,
  })
  await entry.refresh()
  await new Promise((r) => setTimeout(r, 20))
  const urls = log.map((e) => e.url)
  assert.ok(!urls.some((u) => u.endsWith('demo.updateInstall')), '入口件自身生命周期不打 install（只查+打开面板）')
  entry.unmount()
})


// ---------- 入口打开面板后安装可达（#58） ----------

function tapContainer() {
  const listeners = {}
  return {
    innerHTML: '',
    addEventListener(type, fn) {
      ;(listeners[type] ??= []).push(fn)
    },
    removeEventListener() {},
    fire(type, ev) {
      for (const fn of listeners[type] ?? []) fn(ev)
    },
  }
}

function installClickEvent() {
  return {
    target: {
      closest: (sel) => (sel === '[data-action]' ? { getAttribute: () => 'install' } : null),
    },
  }
}

test('入口打开面板后安装可达：updateInstall 正常发出，不再通道拒收（#58）', async () => {
  const { fetch, log } = stubFetch(async (url) => {
    if (url.endsWith('demo.updateStatus')) return okJson({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null })
    if (url.endsWith('demo.updateCheck')) {
      return okJson({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'c-entry', checkedAt: 1, expiresAt: 9999999999999 } })
    }
    if (url.endsWith('demo.updateInstall')) {
      return okJson({ ok: true, snapshot: baseSnapshot({ job: { id: 'j-e', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'req-e' } }), manual: null })
    }
    throw new Error('unknown-url:' + url)
  })
  const box = tapContainer()
  const entry = mountUpdateEntryHttp(box, { pluginId: 'p', prefix: 'demo', baseUrl: 'https://h.local/u', fetch, pollMs: 60000 })
  await new Promise((r) => setTimeout(r, 30))
  entry.open()
  await new Promise((r) => setTimeout(r, 40))
  box.fire('click', installClickEvent())
  await new Promise((r) => setTimeout(r, 30))
  const urls = log.map((e) => e.url)
  assert.ok(urls.some((u) => u.endsWith('demo.updateInstall')), '面板安装电话应正常发出，实际=' + JSON.stringify(urls))
  assert.match(box.innerHTML, /正在安装/, '安装应进入进度态')
  assert.doesNotMatch(box.innerHTML, /只允许只读/, '不得再通道拒收')
  entry.unmount()
});

// ---------- 批量五电话：同一内核（#35） ----------

function baseBatchReply(overrides) {
  return {
    ok: true,
    session: { v: 1, entries: [], updatedAt: 0 },
    rows: [],
    progress: { total: 0, done: 0 },
    ...overrides,
  }
}

test('批量 phone→path：五电话默认走 baseUrl/全电话名（与单插件同一内核）', async () => {
  const { fetch, log } = stubFetch(async () => okJson(baseBatchReply()))
  const call = createHttpCall({ prefix: 'demo', batchPrefix: 'life', baseUrl: 'https://host.local:3000/upd', fetch })
  await call('life.batchStatus', {})
  await call('life.batchCheck', {})
  await call('life.batchInstall', {})
  await call('life.batchResume', {})
  await call('life.batchCancel', {})
  assert.deepEqual(
    log.map((e) => e.url),
    [
      'https://host.local:3000/upd/life.batchStatus',
      'https://host.local:3000/upd/life.batchCheck',
      'https://host.local:3000/upd/life.batchInstall',
      'https://host.local:3000/upd/life.batchResume',
      'https://host.local:3000/upd/life.batchCancel',
    ],
  )
  assert.equal(log[0].init.method, 'POST')
})

test('批量前缀独立：单前缀与批量前缀不串台，缺键各自回落', async () => {
  const { fetch, log } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot() }))
  const call = createHttpCall({ prefix: 'demo', batchPrefix: 'life', baseUrl: 'https://h.local/u', fetch })
  await call('demo.updateCheck', {})
  await call('life.batchCheck', {})
  assert.deepEqual(
    log.map((e) => e.url),
    ['https://h.local/u/demo.updateCheck', 'https://h.local/u/life.batchCheck'],
  )
})

test('批量 routes 优先：全名覆写绝对直用、短键相对拼网关根', async () => {
  const { fetch, log } = stubFetch(async () => okJson(baseBatchReply()))
  const call = createHttpCall({
    prefix: 'demo',
    batchPrefix: 'life',
    baseUrl: 'https://h.local/u',
    routes: { 'life.batchInstall': 'https://dedicated.local/batch-install', batchCheck: '/custom-batch-check' },
    fetch,
  })
  await call('life.batchStatus', {})
  await call('life.batchCheck', {})
  await call('life.batchInstall', {})
  assert.equal(log[0].url, 'https://h.local/u/life.batchStatus')
  assert.equal(log[1].url, 'https://h.local/u/custom-batch-check')
  assert.equal(log[2].url, 'https://dedicated.local/batch-install')
})

test('批量 routes 未知键拒绝：单批量键未声明 batchPrefix 时也不收', () => {
  assert.throws(
    () =>
      createHttpCall({
        prefix: 'demo',
        baseUrl: 'https://h.local/u',
        routes: { 'life.batchCheck': 'https://x.local/y' },
        fetch: async () => okJson({}),
      }),
    /未知键/,
  )
  assert.throws(
    () =>
      createHttpCall({
        prefix: 'demo',
        batchPrefix: 'life',
        baseUrl: 'https://h.local/u',
        routes: { 'life.nope': 'https://x.local/y' },
        fetch: async () => okJson({}),
      }),
    /未知键/,
  )
})

test('批量回包 session/rows/progress 全透传：helper 不裁剪，diagnostic 仍丢弃', async () => {
  const payload = baseBatchReply({
    session: { v: 1, entries: [{ key: 'a' }], updatedAt: 7 },
    rows: [{ key: 'a', phase: 'ready' }],
    progress: { total: 1, done: 0 },
    diagnostic: '原始堆栈不能外泄',
  })
  const { fetch } = stubFetch(async () => okJson(payload))
  const call = createHttpCall({ prefix: 'demo', batchPrefix: 'life', baseUrl: 'https://h.local/u', fetch })
  const reply = await call('life.batchStatus', {})
  assert.deepEqual(reply.rows, [{ key: 'a', phase: 'ready' }])
  assert.deepEqual(reply.session, { v: 1, entries: [{ key: 'a' }], updatedAt: 7 })
  assert.deepEqual(reply.progress, { total: 1, done: 0 })
  assert.ok(!('diagnostic' in reply), 'diagnostic 原话必须丢弃')
})

test('批量超时口径：batchInstall 走装时限（可覆写极小触发传输失败）', async () => {
  const { fetch } = stubFetch(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(okJson(baseBatchReply())), 200)
      }),
  )
  const call = createHttpCall({
    prefix: 'demo',
    batchPrefix: 'life',
    baseUrl: 'https://h.local/u',
    fetch,
    timeout: { installMs: 10 },
  })
  await assert.rejects(call('life.batchInstall', {}), (e) => {
    assert.equal(e.code, 'http-transport-failed')
    return true
  })
})

test('批量 poll 下限：mountUpdateBatchPanelHttp 低于 250ms 与直调同文案抛错', async () => {
  const { fetch } = stubFetch(async () => okJson(baseBatchReply()))
  assert.throws(
    () =>
      mountUpdateBatchPanelHttp(fakeContainer(), {
        batchPrefix: 'life',
        baseUrl: 'https://h.local/u',
        fetch,
        pollMs: 100,
      }),
    /250/,
  )
})

test('批量薄封装：经 HTTP 跑通 status，取消走 batchCancel 电话而不走中止等待', async () => {
  const seen = []
  const { fetch } = stubFetch(async (url) => {
    seen.push(url)
    return okJson(baseBatchReply())
  })
  const box = fakeContainer()
  const panel = mountUpdateBatchPanelHttp(box, {
    batchPrefix: 'life',
    baseUrl: 'https://h.local/u',
    fetch,
    pollMs: 60000,
  })
  await panel.refresh()
  assert.ok(seen.some((u) => u === 'https://h.local/u/life.batchStatus'), '批量面板应打 batchStatus')
  await panel.act('cancel')
  assert.ok(seen.some((u) => u === 'https://h.local/u/life.batchCancel'), '取消整批应走 batchCancel 电话')
  panel.unmount()
})

// ---------- 批量排队/续跑语义在 HTTP 下的落地（#33） ----------

test('批量行内 diag 过滤：只留 16 键，extra 丢、diagnostic 原话丢、detail 脱敏', async () => {
  const payload = baseBatchReply({
    rows: [
      {
        key: 'a',
        phase: 'failed',
        diag: {
          stage: 'exec',
          detail: '  失败了  ',
          requestId: 'req-3',
          extraKey: 'should-be-ignored',
        },
        diagnostic: '原始堆栈不能外泄',
        queue: { busy: true, position: 1 },
      },
    ],
    diagnostic: '顶层原话同样不能外泄',
  })
  const { fetch } = stubFetch(async () => okJson(payload))
  const call = createHttpCall({ prefix: 'demo', batchPrefix: 'life', baseUrl: 'https://h.local/u', fetch })
  const reply = await call('life.batchStatus', {})
  assert.ok(!('diagnostic' in reply), '顶层 diagnostic 必须丢弃')
  const row = reply.rows[0]
  assert.ok(!('diagnostic' in row), '行内 diagnostic 原话必须丢弃')
  assert.equal(row.diag.stage, 'exec')
  assert.equal(row.diag.requestId, 'req-3')
  assert.ok(!('extraKey' in (row.diag ?? {})), '行内 diag 未知键应忽略')
  assert.equal(typeof row.diag.detail, 'string')
  // 行内 queue 原样透传：排队位置不裁剪
  assert.deepEqual(row.queue, { busy: true, position: 1 })
})

test('批量续跑：install 带 keys 原样透传 body，resume 走 batchResume 路径', async () => {
  const seen = []
  const { fetch } = stubFetch(async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) })
    return okJson(baseBatchReply())
  })
  const call = createHttpCall({ prefix: 'demo', batchPrefix: 'life', baseUrl: 'https://h.local/u', fetch })
  await call('life.batchInstall', { keys: ['bill'] })
  await call('life.batchResume', {})
  assert.equal(seen[0].url, 'https://h.local/u/life.batchInstall')
  assert.deepEqual(seen[0].body, { keys: ['bill'] })
  assert.equal(seen[1].url, 'https://h.local/u/life.batchResume')
  assert.deepEqual(seen[1].body, {})
})

test('批量跨范围拒绝透传：cross-scope 不进传输失败通道，原样回 error/errorKind', async () => {
  const { fetch } = stubFetch(async () =>
    okJson({ ok: false, error: 'cross-scope', errorKind: 'cross-scope' }),
  )
  const call = createHttpCall({ prefix: 'demo', batchPrefix: 'life', baseUrl: 'https://h.local/u', fetch })
  const reply = await call('life.batchStatus', {})
  assert.equal(reply.ok, false)
  assert.equal(reply.error, 'cross-scope')
  assert.equal(reply.errorKind, 'cross-scope')
})

test('批量薄封装续跑：check/install/resume/row-install 经 HTTP 打对电话', async () => {
  const seen = []
  const { fetch } = stubFetch(async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) })
    return okJson(baseBatchReply())
  })
  const box = fakeContainer()
  const panel = mountUpdateBatchPanelHttp(box, {
    batchPrefix: 'life',
    baseUrl: 'https://h.local/u',
    fetch,
    pollMs: 60000,
  })
  await panel.act('check')
  await panel.act('install')
  await panel.act('row-install', 'bill')
  await panel.act('resume')
  const urls = seen.map((s) => s.url)
  assert.ok(urls.includes('https://h.local/u/life.batchCheck'), '检查更新应打 batchCheck')
  assert.ok(urls.includes('https://h.local/u/life.batchInstall'), '全部更新应打 batchInstall')
  const rowHit = seen.find((s) => s.url.endsWith('life.batchInstall') && s.body.keys?.[0] === 'bill')
  assert.ok(rowHit, '行内安装这家应带 keys:[bill] 打 batchInstall')
  assert.ok(urls.includes('https://h.local/u/life.batchResume'), '接着上次应打 batchResume')
  panel.unmount()
})

test('批量排队取消不串台：目标单电话默认拼网关根（行取消排队可达）', async () => {
  const { fetch, log } = stubFetch(async () => okJson({ ok: true, snapshot: baseSnapshot() }))
  const call = createHttpCall({ prefix: 'demo', batchPrefix: 'life', baseUrl: 'https://h.local/u', fetch })
  await call('ilife-bill.updateInstall', { cancelQueued: true, requestId: 'req-9' })
  assert.equal(log[0].url, 'https://h.local/u/ilife-bill.updateInstall')
  assert.deepEqual(JSON.parse(log[0].init.body), { cancelQueued: true, requestId: 'req-9' })
})
