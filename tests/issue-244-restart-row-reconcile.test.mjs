/**
 * tests/issue-244-restart-row-reconcile.test.mjs —— #244 检查必须按磁盘真相纠正「已安装完成（待重启）」行。
 *
 * 现场（2026-10-20 web profile）：饼干记账行在会话里是 done + restartRequired（目标 0.3.82），
 * 但磁盘被外部改回 0.3.81 后，点「检查更新」面板仍宣称「已安装完成，重启宿主后生效」——
 * 检查对账把 restartRequired 行整行跳过了，磁盘真相永远进不来。
 *
 * 新口径：
 * - 检查结论是 update ⇒ 行退回 ready + 目标置最新、清 restartRequired（重启也救不回来，得重装）；
 * - 检查结论是 done 且版本一致 ⇒ 保持 done + restartRequired（还在等重启，不动）；
 * - 检查结论是 current ⇒ 行收敛 current、清目标与 restartRequired。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

async function tempScope() {
  const dir = await mkdtemp(join(tmpdir(), 'issue-244-'))
  return { dir, scope: { homeDir: dir, profileDir: dir } }
}

function target(key) {
  return { key, title: '插件 ' + key, packageName: 'pkg-' + key, prefix: 'p-' + key }
}

function entryOf(session, key) {
  return session.entries.find((entry) => entry.key === key) ?? null
}

describe('issue-244：检查纠正 done+restartRequired 行', () => {
  it('磁盘被外部改低（检查结论 update）⇒ 退回 ready、目标置最新、清 restartRequired', async () => {
    const { scope } = await tempScope()
    let checkOutcome = { kind: 'current' }
    let installOutcome = { kind: 'done', restartRequired: true }
    const host = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async () => checkOutcome,
          install: async () => installOutcome,
        },
      },
      { prefix: 'life', targets: [target('a')] },
    )
    // 先制造 done + restartRequired（目标 0.3.55）。
    checkOutcome = { kind: 'update', version: '0.3.55' }
    const drove = await host.handlers['life.batchInstall']({})
    assert.equal(entryOf(drove.session, 'a').phase, 'done')
    assert.equal(entryOf(drove.session, 'a').targetVersion, '0.3.55')
    assert.equal(entryOf(drove.session, 'a').restartRequired, true)

    // 外部把磁盘改回旧版：检查结论回到 update（同一版本号也是「有新版本可装」）。
    checkOutcome = { kind: 'update', version: '0.3.55' }
    const checked = await host.handlers['life.batchCheck']({})
    assert.equal(entryOf(checked.session, 'a').phase, 'ready', '检查结论是磁盘真相，必须退回可安装')
    assert.equal(entryOf(checked.session, 'a').targetVersion, '0.3.55')
    assert.equal(entryOf(checked.session, 'a').restartRequired, false, '磁盘已没有目标版本，不许再宣称待重启')
    host.dispose()
  })

  it('检查结论 done 且版本一致 ⇒ 保持 done+restartRequired（等待重启照旧不动）', async () => {
    const { scope } = await tempScope()
    let checkOutcome = { kind: 'update', version: '0.3.55' }
    const installOutcome = { kind: 'done', restartRequired: true }
    const host = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async () => checkOutcome,
          install: async () => installOutcome,
        },
      },
      { prefix: 'life', targets: [target('a')] },
    )
    const drove = await host.handlers['life.batchInstall']({})
    assert.equal(entryOf(drove.session, 'a').restartRequired, true)
    checkOutcome = { kind: 'done', version: '0.3.55', restartRequired: true }
    const checked = await host.handlers['life.batchCheck']({})
    assert.equal(entryOf(checked.session, 'a').phase, 'done')
    assert.equal(entryOf(checked.session, 'a').targetVersion, '0.3.55')
    assert.equal(entryOf(checked.session, 'a').restartRequired, true)
    host.dispose()
  })

  it('检查结论 current ⇒ 收敛 current、清目标与 restartRequired', async () => {
    const { scope } = await tempScope()
    let checkOutcome = { kind: 'update', version: '0.3.55' }
    const installOutcome = { kind: 'done', restartRequired: true }
    const host = createMultiHostUpdate(
      {
        scope,
        transport: {
          check: async () => checkOutcome,
          install: async () => installOutcome,
        },
      },
      { prefix: 'life', targets: [target('a')] },
    )
    await host.handlers['life.batchInstall']({})
    checkOutcome = { kind: 'current' }
    const checked = await host.handlers['life.batchCheck']({})
    assert.equal(entryOf(checked.session, 'a').phase, 'current')
    assert.equal(entryOf(checked.session, 'a').targetVersion, null)
    assert.equal(entryOf(checked.session, 'a').restartRequired, false)
    host.dispose()
  })
})
