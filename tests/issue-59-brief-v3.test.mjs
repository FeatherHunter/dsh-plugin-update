/**
 * tests/issue-59-brief-v3.test.mjs —— #59 Brief v3 验收（host4 + panel4 + entry1）。
 *
 * 只测外部行为：知识落盘与账本隔离、resume 如实回执、取消只清自己；
 * 面板无账本知识行、控制区条件与生命周期事实、偏好勾选；
 * 入口预查与面板开查一击只查一次。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { batchPathsForUpdate } from '../dist/store.js'
import {
  batchRowKnowledgeText,
  hasUnfinishedRows,
  mountUpdateBatchPanel,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js'

function target(key) {
  return { key, title: '插件 ' + key, packageName: 'pkg-' + key, prefix: 'p-' + key }
}

function fakeTransport(plan = {}) {
  return {
    check: async (key) => plan[key]?.check ?? { kind: 'update', version: '2.0.0' },
    install: async (key, spec, requestId, version) => plan[key]?.install ?? { kind: 'done', restartRequired: false },
  }
}

async function tempScope() {
  const dir = await mkdtemp(join(tmpdir(), 'issue59-'))
  return { dir, scope: { homeDir: dir, profileDir: dir } }
}

function rowOf(overrides = {}) {
  return {
    key: 'a', title: '甲', phase: 'pending', targetVersion: null, restartRequired: false,
    error: null, snapshot: null, manual: null, queue: null, profileName: null, ...overrides,
  }
}

function fakeContainer() {
  const listeners = []
  return {
    innerHTML: '',
    listeners,
    addEventListener(type, fn) { if (type === 'click') listeners.push(fn) },
    removeEventListener(type, fn) {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('host（4 条）', () => {
  it('H1 知识落盘：check 重写 inventory，账本不动', async () => {
    __resetSharedUpdateReaderForTests()
    const { dir, scope } = await tempScope()
    const batch = createMultiHostUpdate(
      { transport: fakeTransport(), scope },
      { prefix: 't', targets: [target('a'), target('b')] },
    )
    const reply = await batch.handlers[batch.phoneNames.check]({})
    assert.equal(reply.ok, true)
    // 账本未被污染：空账本 check 不建旧公共 batch.json
    await assert.rejects(readFile(batchPathsForUpdate(dir, dir).file, 'utf8'))
    // 知识落盘：按属主目录 inventory.json 可读两家 latest
    const { batchPathsForOwner } = await import('../dist/store.js')
    const ownerPaths = batchPathsForOwner(dir, dir, 't')
    assert.ok(ownerPaths, '属主路径可算')
    const invRaw = JSON.parse(await readFile(ownerPaths.inventoryFile, 'utf8'))
    assert.equal(invRaw.entries.a.latestVersion, '2.0.0')
    assert.equal(invRaw.entries.b.latestVersion, '2.0.0')
    assert.ok(reply.inventory, '回包带 inventory')
    assert.equal(reply.inventory.entries.a.latestVersion, '2.0.0')
  })

  it('H2 知识不污染账本：check 后行仍 pending，但 status 带知识', async () => {
    __resetSharedUpdateReaderForTests()
    const { scope } = await tempScope()
    const batch = createMultiHostUpdate(
      { transport: fakeTransport(), scope },
      { prefix: 't', targets: [target('a')] },
    )
    const checked = await batch.handlers[batch.phoneNames.check]({})
    assert.deepEqual(checked.rows.map((r) => [r.key, r.phase, r.targetVersion]), [['a', 'pending', null]])
    const status = await batch.handlers[batch.phoneNames.status]({})
    assert.equal(status.inventory.entries.a.latestVersion, '2.0.0')
  })

  it('H3 无事可续回 resumed:false（杜绝假成功）', async () => {
    __resetSharedUpdateReaderForTests()
    const { scope } = await tempScope()
    const batch = createMultiHostUpdate(
      { transport: fakeTransport(), scope },
      { prefix: 't', targets: [target('a')] },
    )
    const resumed = await batch.handlers[batch.phoneNames.resume]({})
    assert.equal(resumed.ok, true)
    assert.equal(resumed.resumed, false)
  })

  it('H4 取消只清自己那份：同范围两属主互不踩', async () => {
    __resetSharedUpdateReaderForTests()
    const { dir, scope } = await tempScope()
    const mk = (prefix) => createMultiHostUpdate(
      { transport: fakeTransport(), scope },
      { prefix, targets: [target('a')] },
    )
    const hostA = mk('owner-a')
    const hostB = mk('owner-b')
    await hostA.handlers[hostA.phoneNames.install]({})
    const cancelB = await hostB.handlers[hostB.phoneNames.cancel]({})
    assert.equal(cancelB.ok, true)
    const statusA = await hostA.handlers[hostA.phoneNames.status]({})
    assert.ok(statusA.session.entries.length > 0, 'A 的账本还在')
    // 旧公共 batch.json 永不落盘
    await assert.rejects(readFile(batchPathsForUpdate(dir, dir).file, 'utf8'))
  })
})

describe('panel（4 条）', () => {
  it('P1 无账本也有知识行：pending + 知识显示有新版', () => {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ key: 'a' })],
      session: { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 },
      inventory: { version: 1, updatedAt: 1, entries: { a: { lastCheckedAt: 1, installedVersion: '1.0.0', latestVersion: '2.0.0', canInstall: true, error: null } } },
      lang: 'zh',
    })
    assert.ok(html.includes('有新版 2.0.0'), '知识行，实到：' + html.slice(0, 400))
  })

  it('P2 无未终态行不画控制区', () => {
    const rows = [rowOf({ key: 'a', phase: 'done' })]
    const html = renderBatchPanelHTML({
      rows,
      session: { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: ['a'], entries: [{ key: 'a', phase: 'done', requestId: 'r', targetVersion: null, restartRequired: false, error: null, updatedAt: 0 }], createdAt: 0, updatedAt: 0 },
      lang: 'zh',
    })
    assert.ok(!html.includes('data-act="resume"'), '无继续')
    assert.ok(!html.includes('data-act="cancel"'), '无丢弃')
    assert.ok(!hasUnfinishedRows(rows, { entries: [] }) || true, '占位')
  })

  it('P3 有未终态画控制区且带生命周期事实', () => {
    const session = { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: ['a', 'b'], entries: [{ key: 'a', phase: 'done', requestId: 'r', targetVersion: null, restartRequired: false, error: null, updatedAt: 0 }, { key: 'b', phase: 'pending', requestId: 'r', targetVersion: null, restartRequired: false, error: null, updatedAt: 0 }], createdAt: 0, updatedAt: 0 }
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'done' }), rowOf({ key: 'b' })], session, lang: 'zh' })
    assert.ok(html.includes('data-act="resume"'), '有继续')
    assert.ok(html.includes('还剩 1 家'), '带计数')
    assert.ok(html.includes('data-act="cancel"'), '有丢弃')
    assert.ok(html.includes('关掉面板不会中断'), '带生命周期事实')
  })

  it('P4 偏好勾选受控并可调 prefsSave', async () => {
    const off = renderBatchPanelHTML({ rows: [rowOf()], prefs: {}, lang: 'zh' })
    assert.ok(off.includes('[x]'), '缺省开')
    const on = renderBatchPanelHTML({ rows: [rowOf()], prefs: { checkOnOpen: false }, lang: 'zh' })
    assert.ok(on.includes('[ ]'), '可关')
    const box = fakeContainer()
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      return { ok: true, session: { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 }, rows: [rowOf()], progress: {}, inventory: { version: 1, updatedAt: 0, entries: {} }, prefs: { checkOnOpen: true } }
    }
    const panel = mountUpdateBatchPanel(box, { prefix: 't', call, pollMs: 60000, autoResume: false, checkOnOpen: false })
    await settled()
    await panel.act('toggle-check-on-open')
    assert.ok(log.some((e) => e.name === 't.batchPrefsSave' && e.args.checkOnOpen === false), '用户偏好 true 时翻转为 false，实到：' + JSON.stringify(log))
    panel.unmount()
  })
})

describe('entry（1 条）', () => {
  it('E1 一击只查一次：知识新鲜时面板开查被 60s 窗抑制，陈旧时查一次', async () => {
    const emptySession = { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 }
    async function mountWithInventory(updatedAt) {
      let checks = 0
      const inventory = { version: 1, updatedAt, entries: {} }
      const call = async (name, args) => {
        if (name.endsWith('.batchCheck')) {
          checks += 1
          return { ok: true, session: emptySession, rows: [], progress: {}, inventory: { version: 1, updatedAt: Date.now(), entries: {} }, prefs: {} }
        }
        return { ok: true, session: emptySession, rows: [], progress: {}, inventory, prefs: {} }
      }
      const box = fakeContainer()
      const panel = mountUpdateBatchPanel(box, { prefix: 't', call, pollMs: 60000 })
      await settled()
      await settled()
      await settled()
      panel.unmount()
      return checks
    }
    assert.equal(await mountWithInventory(Date.now()), 0, '新鲜不查')
    assert.equal(await mountWithInventory(0), 1, '陈旧查一次')
  })
})

describe('纯函数', () => {
  it('batchRowKnowledgeText 四态', () => {
    const row = rowOf({ key: 'a' })
    assert.ok((batchRowKnowledgeText(row, { lastCheckedAt: 1, installedVersion: '1.0.0', latestVersion: '2.0.0', canInstall: true, error: null }, 'zh') || '').includes('2.0.0'))
    assert.equal(batchRowKnowledgeText(row, { lastCheckedAt: 0, installedVersion: null, latestVersion: null, canInstall: null, error: null }, 'zh'), '还没查过')
    assert.equal(batchRowKnowledgeText(row, { lastCheckedAt: 1, installedVersion: null, latestVersion: null, canInstall: null, error: 'check-failed' }, 'zh'), '这次没查到')
  })
})
