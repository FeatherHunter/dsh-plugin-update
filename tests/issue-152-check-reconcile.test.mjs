/**
 * tests/issue-152-check-reconcile.test.mjs —— #152：检查后置条件。
 *
 * 只测外部行为：先用 batchInstall 落一场旧会话（失败 + 陈旧目标，模拟“昨天”），
 * 再用 batchCheck 查出新版本（模拟“今天点检查更新”），断言面板拿到的不再是昨天的数据。
 * 渲染倒挂用纯函数 batchRowVersionParts 直断。
 *
 * 后置条件：点一次检查更新，面板里不许再出现昨天的数据——要么是刚查到的结论，
 * 要么明说没查到。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { batchRowVersionParts } from '../dist/panel-batch.js'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

async function tempScope() {
  const dir = await mkdtemp(join(tmpdir(), 'issue-152-'))
  return { dir, scope: { homeDir: dir, profileDir: dir } }
}

function target(key) {
  return { key, title: '插件 ' + key, packageName: 'pkg-' + key, prefix: 'p-' + key }
}

function entryOf(session, key) {
  return session.entries.find((entry) => entry.key === key) ?? null
}

describe('issue-152：新鲜检查必须冲掉陈旧会话', () => {
  it('失败行 + 陈旧目标行：查出新版后相位置 ready、目标置新', async () => {
    const { scope } = await tempScope()
    let latest = '0.3.55'
    const host = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async () => ({ kind: 'update', version: latest }),
          install: async () => ({ kind: 'failed', error: 'invalid-installation' }),
        },
      },
      { prefix: 'life', targets: [target('a'), target('b')] },
    )
    // “昨天”：装 0.3.55，全失败，会话里留下 failed + 陈旧目标。
    const drove = await host.handlers['life.batchInstall']({})
    assert.equal(drove.ok, true)
    assert.equal(entryOf(drove.session, 'a').phase, 'failed')
    assert.equal(entryOf(drove.session, 'a').targetVersion, '0.3.55')
    // “今天”：远端已是 0.3.61，点检查更新（只查不装）。
    latest = '0.3.61'
    const checked = await host.handlers['life.batchCheck']({})
    assert.equal(checked.ok, true)
    assert.equal(entryOf(checked.session, 'a').phase, 'ready', '新鲜结论必须替代昨日失败')
    assert.equal(entryOf(checked.session, 'a').targetVersion, '0.3.61', '陈旧目标必须被新版本替代')
    assert.equal(entryOf(checked.session, 'a').error, null)
    assert.equal(entryOf(checked.session, 'b').phase, 'ready')
    assert.equal(entryOf(checked.session, 'b').targetVersion, '0.3.61')
    host.dispose()
  })

  it('done 行带陈旧目标：查出新版后同样置 ready + 目标置新（生产原样：0.3.55 done 遇 0.3.61）', async () => {
    const { scope } = await tempScope()
    let latest = '0.3.55'
    const host = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async () => ({ kind: 'update', version: latest }),
          install: async () => ({ kind: 'done', restartRequired: false }),
        },
      },
      { prefix: 'life', targets: [target('a')] },
    )
    const drove = await host.handlers['life.batchInstall']({})
    assert.equal(entryOf(drove.session, 'a').phase, 'done')
    latest = '0.3.61'
    const checked = await host.handlers['life.batchCheck']({})
    assert.equal(entryOf(checked.session, 'a').phase, 'ready')
    assert.equal(entryOf(checked.session, 'a').targetVersion, '0.3.61')
    host.dispose()
  })

  it('#244：restartRequired 行遇新鲜检查为 update ⇒ 退回 ready（磁盘真相优先）', async () => {
    const { scope } = await tempScope()
    let latest = '0.3.55'
    const host = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async () => ({ kind: 'update', version: latest }),
          install: async () => ({ kind: 'done', restartRequired: true }),
        },
      },
      { prefix: 'life', targets: [target('a')] },
    )
    const drove = await host.handlers['life.batchInstall']({})
    assert.equal(entryOf(drove.session, 'a').restartRequired, true)
    latest = '0.3.61'
    const checked = await host.handlers['life.batchCheck']({})
    assert.equal(entryOf(checked.session, 'a').phase, 'ready', '磁盘没有目标版本时不许再宣称已安装完成')
    assert.equal(entryOf(checked.session, 'a').targetVersion, '0.3.61')
    assert.equal(entryOf(checked.session, 'a').restartRequired, false)
    host.dispose()
  })

  it('检查失败的行：会话原样保留（没学到新东西就不覆盖旧事实）', async () => {    const { scope } = await tempScope()
    let failCheck = false
    const host = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async () => (failCheck ? { kind: 'failed', error: 'check-failed' } : { kind: 'update', version: '0.3.55' }),
          install: async () => ({ kind: 'failed', error: 'invalid-installation' }),
        },
      },
      { prefix: 'life', targets: [target('a')] },
    )
    await host.handlers['life.batchInstall']({})
    failCheck = true
    const checked = await host.handlers['life.batchCheck']({})
    assert.equal(entryOf(checked.session, 'a').phase, 'failed', '检查失败不能洗掉安装失败')
    assert.equal(entryOf(checked.session, 'a').error, 'invalid-installation')
    host.dispose()
  })

  it('失败行 + 新查为 current：失败已无对象，相位置 current 并清错', async () => {
    const { scope } = await tempScope()
    let mode = 'update'
    const host = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async () => (mode === 'current' ? { kind: 'current' } : { kind: 'update', version: '0.3.55' }),
          install: async () => ({ kind: 'failed', error: 'invalid-installation' }),
        },
      },
      { prefix: 'life', targets: [target('a')] },
    )
    await host.handlers['life.batchInstall']({})
    mode = 'current'
    const checked = await host.handlers['life.batchCheck']({})
    assert.equal(entryOf(checked.session, 'a').phase, 'current', '已是最新时昨日失败不再置顶')
    assert.equal(entryOf(checked.session, 'a').targetVersion, null)
    assert.equal(entryOf(checked.session, 'a').error, null)
    host.dispose()
  })
})

describe('issue-152：倒挂目标永不画成“新版本”', () => {
  it('会话目标比当前老：不画箭头（生产原样：0.3.60 → 0.3.55）', () => {
    const row = {
      key: 'life-pack',
      title: '爱生活',
      phase: 'done',
      targetVersion: '0.3.55',
      restartRequired: false,
      error: null,
      snapshot: { installed: true, runningVersion: '0.3.60', installedVersion: '0.3.60' },
    }
    const parts = batchRowVersionParts(row, null)
    assert.equal(parts.hasUpdate, false, '降级不许当更新展示')
    assert.equal(parts.latest, null)
    assert.equal(parts.current, '0.3.60')
  })

  it('会话目标比当前新：照常画箭头（别矫枉过正）', () => {
    const row = {
      key: 'bill',
      title: '饼干记账',
      phase: 'ready',
      targetVersion: '0.3.61',
      restartRequired: false,
      error: null,
      snapshot: { installed: true, runningVersion: '0.3.60', installedVersion: '0.3.60' },
    }
    const parts = batchRowVersionParts(row, null)
    assert.equal(parts.hasUpdate, true)
    assert.equal(parts.latest, '0.3.61')
  })

  it('知识最新版比当前老：同样不画箭头', () => {
    const row = {
      key: 'x',
      title: 'x',
      phase: 'pending',
      targetVersion: null,
      restartRequired: false,
      error: null,
      snapshot: { installed: true, runningVersion: '0.3.60', installedVersion: '0.3.60' },
    }
    const knowledge = {
      lastCheckedAt: 1,
      installed: true,
      installedVersion: '0.3.60',
      latestVersion: '0.3.55',
      canInstall: true,
      error: null,
    }
    const parts = batchRowVersionParts(row, knowledge)
    assert.equal(parts.hasUpdate, false)
  })
})
