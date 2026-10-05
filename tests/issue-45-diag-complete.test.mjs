/**
 * tests/issue-45-diag-complete.test.mjs —— #45 查新版失败复制诊断一次给全.
 *
 * 只测外部行为（公开电话最高口 + 公开复制入口 + 挂载控制器），不测内部实现。
 * 缝：电话失败回包形状（含 env/queue 选填）、复制块文本、控制器失败消费。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { buildUpdateDiagCopy, mountUpdatePanel } from '../dist/panel.js'
import { emptyQueueState } from '../dist/queue.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'

function memoryStore() {
  let job = null
  let locked = null
  return {
    readJob: async () => job,
    writeJob: async (value) => {
      job = value
    },
    tryAcquireLock: async (id) => {
      if (locked !== null) return false
      locked = id
      return true
    },
    releaseLock: async (id) => {
      if (locked === id) locked = null
    },
    backupJob: async () => {},
  }
}

function eligibleEnv(installedVersion = '1.0.0') {
  return {
    profileName: 'web',
    environmentKind: 'cli',
    homeDir: 'C:\\fake\\home',
    profileDir: 'C:\\fake\\profile',
    installedVersion,
    packageValid: true,
    sourceInstall: false,
    blockedReason: null,
    installationKey: 'fake-key',
    eligible: true,
  }
}

function failRelease(status = 500) {
  return async () => ({ ok: false, status, headers: { get: () => null }, text: async () => 'boom' })
}

function makeHost({ installedVersion = '1.0.0', fetchImpl } = {}) {
  const store = memoryStore()
  let queueState = emptyQueueState()
  const host = createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion: '1.0.0',
        profileDir: 'C:\\fake\\profile',
        profileName: 'web',
        homeDir: 'C:\\fake\\home',
        fetchImpl: fetchImpl ?? failRelease(),
        now: () => 1_000_000,
        randomId: (() => {
          let n = 0
          return () => 'id-' + (n += 1)
        })(),
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        readInstalled: async () => eligibleEnv(installedVersion),
        readQueue: async () => queueState,
        writeQueue: async (s) => {
          queueState = s
        },
        ...store,
        runInstall: async () => {},
      },
    },
    { pluginId: 'p45' },
  )
  return host
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

// ---------- 复制块使用范围恒显 ----------

test('#45 复制块使用范围恒显：已知显示真值，未知显示未知不猜', () => {
  const known = buildUpdateDiagCopy({ pluginId: 'p', code: 'check-failed', detail: '', profileName: 'web' })
  assert.match(known, /使用范围=web/, '已知使用范围必须进复制块')
  const unknown = buildUpdateDiagCopy({ pluginId: 'p', code: 'check-failed', detail: '' })
  assert.match(unknown, /使用范围=未知/, '未知也不猜，恒显未知')
})

test('#45 复制块顺序：使用范围紧跟宿主、在路由之前', () => {
  const block = buildUpdateDiagCopy({
    pluginId: 'p',
    code: 'check-failed',
    detail: '',
    hostKind: 'cli',
    profileName: 'web',
    diag: { v: 1, stage: 'fetch-release', route: 'registry', method: 'https', httpStatus: 500 },
  })
  const hostAt = block.indexOf('宿主=')
  const profAt = block.indexOf('使用范围=')
  const routeAt = block.indexOf('路由=')
  assert.ok(hostAt >= 0 && profAt > hostAt, '使用范围在宿主之后')
  assert.ok(routeAt > profAt, '路由在使用范围之后')
})

// ---------- 电话失败也带 env/queue（显式要才带） ----------

test('#45 电话失败带 env 与 queue：includeEnv/includeQueue 时给，老调用不带则一字不变', async () => {
  __resetSharedUpdateReaderForTests()
  const host = makeHost({})
  const out = await host.handlers['wf.updateCheck']({ includeEnv: true, includeQueue: true, requestId: 'id-1' })
  assert.equal(out.ok, false, '取数 500 应失败')
  assert.ok(out.diag, '失败须带 diag（只增不改）')
  assert.ok(out.env, '显式要 env 时失败也给')
  assert.equal(out.env.profileName, 'web')
  assert.equal(out.env.environmentKind, 'cli')
  assert.ok(out.queue, '显式要 queue 时失败也给队列视图')
  __resetSharedUpdateReaderForTests()
})

test('#45 老调用形状不变：不带 includeEnv/includeQueue 时失败无 env/queue 键', async () => {
  __resetSharedUpdateReaderForTests()
  const host = makeHost({})
  const out = await host.handlers['wf.updateCheck']({})
  assert.equal(out.ok, false)
  assert.ok(out.diag, 'diag 照给')
  assert.ok(!('env' in out), '没要 env 就不带该键')
  assert.ok(!('queue' in out), '没要 queue 就不带该键')
  __resetSharedUpdateReaderForTests()
})

// ---------- 面板失败也收 env/queue，快照不动 ----------

test('#45 面板失败收 env：复制块宿主与使用范围来自失败回包，快照不动', async () => {
  const box = fakeContainer()
  const texts = []
  const call = async (name) => {
    if (name.endsWith('.updateStatus')) {
      return {
        ok: false,
        error: 'check-failed',
        errorKind: 'check-failed',
        diag: { v: 1, stage: 'fetch-release', route: 'registry', method: 'https', httpStatus: 503 },
        env: { profileName: 'web', environmentKind: 'desktop' },
        queue: { busy: false, owner: null, waiting: [], position: null },
      }
    }
    throw new Error('unknown-phone:' + name)
  }
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, copyText: async (t) => texts.push(t), pollMs: 60000 })
  await panel.refresh()
  assert.match(box.innerHTML, /web/, '表头使用范围来自失败 env')
  await panel.act('copy-diag')
  assert.equal(texts.length, 1)
  assert.match(texts[0], /宿主=desktop/, '复制块宿主来自失败 env')
  assert.match(texts[0], /使用范围=web/, '复制块使用范围来自失败 env')
  assert.match(texts[0], /HTTP=503/, 'diag 明细照渲染')
  panel.unmount()
})

test('#45 面板失败无 env 时诚实未知：不猜，快照不断', async () => {
  const box = fakeContainer()
  const texts = []
  const call = async () => ({ ok: false, error: 'check-failed', errorKind: 'check-failed' })
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, copyText: async (t) => texts.push(t), pollMs: 60000 })
  await panel.refresh()
  await panel.act('copy-diag')
  assert.match(texts[0], /宿主=未知/, '无 env 即未知，不猜')
  assert.match(texts[0], /使用范围=未知/, '无范围即未知，不猜')
  panel.unmount()
})
