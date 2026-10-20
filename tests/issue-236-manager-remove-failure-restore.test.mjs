/**
 * tests/issue-236-manager-remove-failure-restore.test.mjs —— 管理器路：#201 的反向路径（#236）。
 *
 * 背景（真机 2026-10-20 04:12 +08，六个 life-* 单品批量更新全部失败 `bundle-in-use`）：
 * 宿主的 `removeBundle` 对**在册**的 bundle 先 `selectBundle(false)`（立即写盘）再 reload 卸载，
 * 卸载不掉抛 `bundle-in-use`，而没有回滚那次取消选中。于是本包拿到「移除失败」时，插件已经
 * 装着、却不在 `dsh.profile.bundles` 里——插件页显示关闭，重启也不加载，只能用户手动启用。
 *
 * 钉死的契约（直接跑执行器 `dist/core/executor.js`，假管理器记录调用序列）：
 * 1. 移除前已在册 + 移除失败 + 复探确认已被移出 ⇒ 恢复在册并复探，抛原失败但补事实「已恢复在册」；
 * 2. 恢复在册被拒 ⇒ 抛原失败、事实说未成功，不重试安装；
 * 3. 恢复后复探仍显示关闭 ⇒ 如实说未成功（不谎报已恢复）；
 * 4. 装前本来未在册（#201 先恢复在册再移除）⇒ 不追加恢复动作，回到用户原本状态；
 * 5. 老宿主没有 `listBundles`（前置态未知）⇒ 不猜拓扑、不动在册名单，行为与从前一致；
 * 6. `listBundles` 抛错（探测失效）⇒ 同样不猜拓扑；
 * 7. 移除超时未落定 ⇒ 仍尝试恢复并补事实；
 * 8. 宿主没有 `setBundleEnabled` ⇒ 不宣称「尝试过恢复」，只说无法确认；
 * 9. 复探失效且恢复被拒 ⇒ 说无法确认，不把「可能已移出」写成事实；
 * 10. `removeBundle` 同步抛错 ⇒ 同样走补偿（不许跳过）；
 * 11. 宿主原话超长 ⇒ 截断原文也要保住补偿事实，总长仍守 300。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateExecutor } from '../dist/core/executor.js'
import { readInstallFail } from '../dist/core/failure.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const SPEC = `${TARGET}@2.0.0`
const PROFILE = 'desktop'
const REGISTRY = 'https://registry.npmjs.org/'

const ALREADY_INSTALLED = { application: 'failed', error: { code: 'already-installed' } }

/** 一行宿主拓扑（默认「装着、在册、可移除」，按用例覆盖）。 */
function row(overrides = {}) {
  return { name: TARGET, installed: true, enabled: true, removable: true, ...overrides }
}

/**
 * 假管理器：`listBundles` 按脚本一行一行回（不足时重复最后一行），其余调用按脚本回话。
 * 安装步固定回 `already-installed`——本票全部用例都在「两步配方第一步就失败」的路径上。
 */
function makeManager(script) {
  const calls = []
  const rows = script.listBundles === undefined ? null : script.listBundles.map((item) => (Array.isArray(item) ? item : [item]))
  let bundleIndex = 0
  const manager = {
    installBundle(spec, options) {
      calls.push(['installBundle', spec, options?.requestId])
      return ALREADY_INSTALLED
    },
    removeBundle(name) {
      calls.push(['removeBundle', name])
      return typeof script.remove === 'function' ? script.remove() : (script.remove ?? { application: 'applied' })
    },
  }
  if (rows !== null) {
    manager.listBundles = () => {
      calls.push(['listBundles'])
      const at = Math.min(bundleIndex, rows.length - 1)
      bundleIndex += 1
      return rows[at]
    }
  }
  manager.setBundleEnabled = (name, enabled) => {
    calls.push(['setBundleEnabled', name, enabled])
    return typeof script.setBundleEnabled === 'function' ? script.setBundleEnabled() : (script.setBundleEnabled ?? { changed: true, application: 'applied' })
  }
  return { manager, calls }
}

function run(manager, parts = {}) {
  const executor = createUpdateExecutor({
    profileName: PROFILE,
    environmentKind: 'desktop-manager',
    targetPackageName: TARGET,
    registryUrl: REGISTRY,
    pluginManager: manager,
    ...parts,
  })
  return executor({ version: '2.0.0', profileName: PROFILE, environmentKind: 'desktop-manager' })
}

describe('#236 管理器路：移除失败后补偿「宿主已取消在册」', () => {
  it('在册 + 移除失败 + 复探为未在册：恢复在册并如实补事实，不重试安装', async () => {
    const { manager, calls } = makeManager({
      listBundles: [[row()], [row({ enabled: false })], [row()]],
      remove: { application: 'failed', error: { code: 'bundle-in-use' } },
    })
    await assert.rejects(run(manager), (error) => {
      assert.equal(error.code, 'install-failed')
      // 原失败分类一字不动（Spec 修形3）：只追加事实，不改 code/reason/hostCode。
      const facts = readInstallFail(error)
      assert.equal(facts?.reason, 'host-rejected')
      assert.equal(facts?.hostCode, 'bundle-in-use')
      assert.match(error.detail, /bundle-in-use/, '宿主原话必须在前')
      assert.ok(
        error.detail.indexOf('bundle-in-use') < error.detail.indexOf('已恢复在册'),
        `原文必须排在补偿事实之前，实际：${error.detail}`,
      )
      assert.match(error.detail, /重启 DSH 后可重试/, '恢复后按根因给「重启后重试」，不许说「可直接重试」')
      assert.ok(!error.detail.includes('可直接重试'), `活 fiber 还在，直接重试只会再撞，实际：${error.detail}`)
      assert.ok(!error.detail.includes('停用后再更新'), '旧的反向建议不该再出现')
      assert.ok(error.detail.length <= 300, `详情超 300：${error.detail.length}`)
      return true
    })
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle', 'listBundles', 'setBundleEnabled', 'listBundles'],
      '恢复后再装一次是禁止的：更新失败如实上报，只补偿在册状态',
    )
    assert.deepEqual(calls[4], ['setBundleEnabled', TARGET, true])
    assert.equal(calls.filter((call) => call[0] === 'installBundle').length, 1)
  })

  it('恢复在册被拒：原失败照抛，事实说未成功，不重试安装', async () => {
    const { manager, calls } = makeManager({
      listBundles: [[row()], [row({ enabled: false })]],
      remove: { application: 'failed', error: { code: 'bundle-in-use' } },
      setBundleEnabled: { application: 'failed', error: { code: 'permission' } },
    })
    await assert.rejects(run(manager), (error) => {
      assert.equal(error.code, 'install-failed')
      const facts = readInstallFail(error)
      assert.equal(facts?.reason, 'host-rejected')
      assert.equal(facts?.hostCode, 'bundle-in-use')
      assert.match(error.detail, /bundle-in-use/)
      assert.match(error.detail, /恢复在册未成功/, `恢复失败要如实说，实际：${error.detail}`)
      assert.ok(!error.detail.includes('已恢复在册'))
      return true
    })
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle', 'listBundles', 'setBundleEnabled'],
    )
    assert.equal(calls.filter((call) => call[0] === 'installBundle').length, 1)
  })

  it('恢复调用成功但复探仍显示关闭：如实说未成功（不谎报已恢复）', async () => {
    const { manager } = makeManager({
      listBundles: [[row()], [row({ enabled: false })], [row({ enabled: false })]],
      remove: { application: 'failed', error: { code: 'bundle-in-use' } },
    })
    await assert.rejects(run(manager), (error) => {
      assert.match(error.detail, /恢复在册未成功/, `复探没启用成功就不能说已恢复，实际：${error.detail}`)
      assert.ok(!error.detail.includes('已恢复在册'))
      return true
    })
  })

  it('装前本来未在册（#201 先恢复在册再移除）失败：不追加恢复动作，回到用户原本状态', async () => {
    const { manager, calls } = makeManager({
      listBundles: [[row({ enabled: false })]],
      remove: { application: 'failed', error: { code: 'bundle-in-use' } },
    })
    await assert.rejects(run(manager), (error) => {
      assert.match(error.detail, /bundle-in-use/)
      assert.ok(!/已恢复在册|恢复在册未成功/.test(error.detail), `装前就关着，不该擅自改动，实际：${error.detail}`)
      return true
    })
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'setBundleEnabled', 'removeBundle'],
      '只在装前恢复在册，移除失败后不再二次改拓扑',
    )
  })

  it('老宿主没有 listBundles（前置态未知）：行为与从前一致，只换掉了误导提示', async () => {
    const manager = {
      calls: [],
      installBundle(spec) {
        this.calls.push(['installBundle', spec])
        return ALREADY_INSTALLED
      },
      removeBundle(name) {
        this.calls.push(['removeBundle', name])
        return { application: 'failed', error: { code: 'bundle-in-use' } }
      },
    }
    await assert.rejects(run(manager), (error) => {
      assert.match(error.detail, /bundle-in-use/)
      assert.match(error.detail, /请重启 DSH 后重试更新/, `老宿主也要给下一步，实际：${error.detail}`)
      assert.ok(!/已恢复在册|恢复在册未成功/.test(error.detail))
      return true
    })
    assert.deepEqual(
      manager.calls.map((call) => call[0]),
      ['installBundle', 'removeBundle'],
      '没有探测能力时不猜拓扑，也不越过移除去改在册名单',
    )
  })

  it('listBundles 抛错（探测失效）：同样不猜拓扑、不动在册名单', async () => {
    const calls = []
    const manager = {
      installBundle() {
        calls.push(['installBundle'])
        return ALREADY_INSTALLED
      },
      removeBundle(name) {
        calls.push(['removeBundle', name])
        return { application: 'failed', error: { code: 'bundle-in-use' } }
      },
      listBundles() {
        calls.push(['listBundles'])
        throw new Error('probe exploded')
      },
      setBundleEnabled() {
        calls.push(['setBundleEnabled'])
        return { changed: true, application: 'applied' }
      },
    }
    await assert.rejects(run(manager), (error) => {
      assert.match(error.detail, /bundle-in-use/)
      assert.ok(!/已恢复在册|恢复在册未成功/.test(error.detail))
      return true
    })
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle'],
      '探测失效时前置态未知，不许拿缺省当「在册」去恢复',
    )
  })

  it('移除超时未落定：仍尝试恢复并补事实', async () => {
    const { manager, calls } = makeManager({
      listBundles: [[row()], [row({ enabled: false })], [row()]],
      remove: () => new Promise(() => {}),
    })
    await assert.rejects(run(manager, { installTimeoutMs: 30 }), (error) => {
      assert.match(error.detail, /移除已装包超时/, '超时口径必须保留在前')
      assert.ok(
        error.detail.indexOf('移除已装包超时') < error.detail.indexOf('已恢复在册'),
        `原文必须排在补偿事实之前，实际：${error.detail}`,
      )
      assert.match(error.detail, /已恢复在册/, `超时后已补偿要如实说，实际：${error.detail}`)
      return true
    })
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle', 'listBundles', 'setBundleEnabled', 'listBundles'],
    )
    assert.equal(calls.filter((call) => call[0] === 'installBundle').length, 1)
  })

  it('宿主没有 setBundleEnabled：不宣称尝试过恢复，只说无法确认', async () => {
    const { manager, calls } = makeManager({
      listBundles: [[row()], [row({ enabled: false })]],
      remove: { application: 'failed', error: { code: 'bundle-in-use' } },
    })
    delete manager.setBundleEnabled
    await assert.rejects(run(manager), (error) => {
      assert.match(error.detail, /无法确认/, `没这能力就只说无法确认，实际：${error.detail}`)
      assert.ok(!error.detail.includes('已尝试'), `不许宣称一次没发起的尝试，实际：${error.detail}`)
      assert.ok(!error.detail.includes('恢复在册未成功'), `没试过就不能说失败，实际：${error.detail}`)
      return true
    })
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle', 'listBundles'],
      '没有恢复能力时一次 setBundleEnabled 都不该发',
    )
  })

  it('复探失效（listBundles 抛错）且恢复被拒：只说无法确认，不把「可能已移出」写成事实', async () => {
    const calls = []
    let probes = 0
    const manager = {
      installBundle() {
        calls.push(['installBundle'])
        return ALREADY_INSTALLED
      },
      removeBundle(name) {
        calls.push(['removeBundle', name])
        return { application: 'failed', error: { code: 'bundle-in-use' } }
      },
      listBundles() {
        calls.push(['listBundles'])
        probes += 1
        if (probes === 1) return [row()]
        throw new Error('probe exploded')
      },
      setBundleEnabled() {
        calls.push(['setBundleEnabled'])
        return { application: 'failed', error: { code: 'permission' } }
      },
    }
    await assert.rejects(run(manager), (error) => {
      assert.match(error.detail, /无法确认/, `复探失效就只能说无法确认，实际：${error.detail}`)
      assert.ok(!error.detail.includes('已把这个插件移出在册名单'), `没看到就不能写成事实，实际：${error.detail}`)
      assert.ok(!error.detail.includes('恢复在册未成功'), `前置结论不明不许说恢复失败，实际：${error.detail}`)
      return true
    })
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle', 'listBundles', 'setBundleEnabled'],
    )
  })

  it('removeBundle 同步抛错：补偿照样发生（不跳过在册恢复）', async () => {
    const { manager, calls } = makeManager({
      listBundles: [[row()], [row({ enabled: false })], [row()]],
      remove: () => {
        throw new Error('sync boom')
      },
    })
    await assert.rejects(run(manager), (error) => {
      assert.match(error.detail, /sync boom/)
      assert.match(error.detail, /已恢复在册/, `同步抛错也要补偿，实际：${error.detail}`)
      return true
    })
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle', 'listBundles', 'setBundleEnabled', 'listBundles'],
    )
  })

  it('宿主原话超长：截断原文也要保住补偿事实，总长守 300', async () => {
    const long = 'x'.repeat(400)
    const { manager } = makeManager({
      listBundles: [[row()], [row({ enabled: false })], [row()]],
      remove: { application: 'failed', packageResult: { output: long } },
    })
    await assert.rejects(run(manager), (error) => {
      assert.ok(error.detail.length <= 300, `详情超 300：${error.detail.length}`)
      assert.ok(error.detail.startsWith('xxx'), `原文（哪怕截断）仍要排在最前，实际：${error.detail}`)
      assert.match(error.detail, /已恢复在册/, `事实不能因为原文太长被挤掉，实际：${error.detail}`)
      return true
    })
  })
})
