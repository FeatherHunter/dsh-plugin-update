/**
 * tests/issue-201-manager-recovery.test.mjs —— 管理器路：已装包的拓扑修复与诚实兜底（#201，S1）。
 *
 * 背景（真机 2026-10-18 01:25，五个插件 + im-companion 全部 2–3ms 失败 `bundle-in-use`）：
 * 官方桌面版的 `removeBundle` 只对**选中**的 bundle 先取消选中再重载卸载；装着、也在跑、
 * 却不在 `dsh.profile.bundles` 选中名单里的包，卸载永远判 `bundle-in-use`——两步配方走不完，
 * 升级永久失败。修形：移除前先探宿主拓扑（`listBundles`），不可移除就诚实拒绝；未选中就用
 * 宿主能力恢复选中（`setBundleEnabled`），再走移除+重装。
 *
 * 钉死的契约（直接跑执行器 `dist/core/executor.js`，假管理器记录调用序列）：
 * 1. 未选中 + 可移除 ⇒ 先 `setBundleEnabled(name, true)`，再 remove→install，成功；
 * 2. 已选中 ⇒ 不碰选中名单，直接 remove→install（旧行为不变）；
 * 3. 不可移除 ⇒ 不调 remove，诚实失败，细节带宿主码 + 中文下一步 + 载体 CLI 命令；
 * 4. 宿主没有 `listBundles`（老宿主）⇒ 退回旧两步，成功；
 * 5. 有探测但没 `setBundleEnabled` ⇒ 不调 remove，诚实失败（「宿主不支持恢复选中」）并给手工命令；
 * 6. 清单行缺 `enabled` / `removable` 格（异形老宿主形状）⇒ 不拿缺省当否，退回旧两步；
 * 7. 恢复选中失败（如 `permission`）⇒ 失败详情同样补载体 CLI 命令，且不往下摘包；
 * 8. 恢复选中超时 ⇒ 人话格说明是启用步超时并给命令；
 * 9. `listBundles` 抛错的宿主 ⇒ 退回旧两步（探测异常不冒充「不可用」）。
 * 10. 载体命令用配方自己的使用范围名与同源源地址，不写死 `desktop`（命令单源，审查 HARD）；
 * 11. 使用范围名含 shell 元字符（`$`/空格等）⇒ 宁可不给命令，也不给会被展开/截断的假命令。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateExecutor } from '../dist/core/executor.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const SPEC = `${TARGET}@2.0.0`
const PROFILE = 'desktop'
const REGISTRY = 'https://registry.npmjs.org/'

/** 假管理器：按脚本回话，按顺序记录调用（名字 + 关键参数）。 */
function makeManager(script) {
  const calls = []
  const queue = [...(script.installs ?? [])]
  const manager = {
    installBundle(spec, options) {
      calls.push(['installBundle', spec, options?.requestId])
      const next = queue.shift()
      if (!next) throw new Error('installBundle 调用次数超出脚本')
      return next
    },
    removeBundle(name) {
      calls.push(['removeBundle', name])
      return script.remove ?? { application: 'applied' }
    },
    listBundles() {
      calls.push(['listBundles'])
      if (Object.hasOwn(script, 'listBundles')) return script.listBundles
      throw new Error('listBundles 不该被调用')
    },
    setBundleEnabled(name, enabled) {
      calls.push(['setBundleEnabled', name, enabled])
      if (typeof script.setBundleEnabled === 'function') return script.setBundleEnabled()
      return script.setBundleEnabled ?? { changed: true, application: 'applied' }
    },
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

const ALREADY_INSTALLED = { application: 'failed', error: { code: 'already-installed' } }
const OK = { application: 'restart-required' }

describe('#201 管理器路：已装包先探拓扑再走两步配方', () => {
  it('未选中但可移除：先恢复选中，再移除+重装', async () => {
    const { manager, calls } = makeManager({
      installs: [ALREADY_INSTALLED, OK],
      listBundles: [{ name: TARGET, installed: true, enabled: false, removable: true }],
    })
    await run(manager)
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'setBundleEnabled', 'removeBundle', 'installBundle'],
    )
    assert.deepEqual(calls[2], ['setBundleEnabled', TARGET, true])
    assert.deepEqual(calls[3], ['removeBundle', TARGET])
    assert.equal(calls[0][1], SPEC)
    assert.equal(calls[4][1], SPEC)
    assert.notEqual(calls[0][2], calls[4][2], '两次安装必须用不同 requestId')
  })

  it('已选中：不碰选中名单，直接移除+重装（旧行为一字不动）', async () => {
    const { manager, calls } = makeManager({
      installs: [ALREADY_INSTALLED, OK],
      listBundles: [{ name: TARGET, installed: true, enabled: true, removable: true }],
    })
    await run(manager)
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle', 'installBundle'],
    )
  })

  it('不可移除：不调 remove，失败细节带宿主码、中文下一步和载体 CLI 命令', async () => {
    const { manager, calls } = makeManager({
      installs: [ALREADY_INSTALLED],
      listBundles: [{ name: TARGET, installed: true, enabled: false, removable: false }],
    })
    await assert.rejects(run(manager), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.match(error.detail, /not-removable/)
      assert.match(error.detail, /不可移除/)
      assert.ok(
        error.detail.includes(`dsh plugin --profile desktop add --save-exact ${SPEC} --registry=${REGISTRY}`),
        `必须给一条一定能用的完整命令（含 --registry），实际：${error.detail}`
      )
      return true
    })
    assert.equal(calls.some((call) => call[0] === 'removeBundle'), false, '不可移除时绝不该真去移除')
  })

  it('老宿主没有 listBundles：退回旧两步配方', async () => {
    const plain = {
      calls: [],
      installBundle(spec) {
        this.calls.push(['installBundle', spec])
        return this.calls.length === 1 ? ALREADY_INSTALLED : OK
      },
      removeBundle(name) {
        this.calls.push(['removeBundle', name])
        return { application: 'applied' }
      },
    }
    await run(plain)
    assert.deepEqual(
      plain.calls.map((call) => call[0]),
      ['installBundle', 'removeBundle', 'installBundle'],
    )
  })

  it('有探测但宿主没有 setBundleEnabled：不调 remove，诚实失败并给手工命令', async () => {
    const calls = []
    const manager = {
      installBundle() {
        calls.push(['installBundle'])
        return ALREADY_INSTALLED
      },
      removeBundle(name) {
        calls.push(['removeBundle', name])
        return { application: 'applied' }
      },
      listBundles() {
        calls.push(['listBundles'])
        return [{ name: TARGET, installed: true, enabled: false, removable: true }]
      },
    }
    await assert.rejects(run(manager), (error) => {
      assert.equal(error.code, 'install-failed')
      // 真实原因是「宿主缺恢复选中能力」，不许合成 bundle-in-use 冒充「还有别的层在用」。
      assert.match(error.detail, /宿主不支持恢复选中/)
      assert.doesNotMatch(error.detail, /bundle-in-use|别的层在用/)
      assert.ok(
        error.detail.includes(`dsh plugin --profile desktop add --save-exact ${SPEC} --registry=${REGISTRY}`),
        `无能力时也必须给完整命令（含 --registry），实际：${error.detail}`
      )
      return true
    })
    assert.equal(calls.some((call) => call[0] === 'removeBundle'), false)
  })

  it('恢复选中失败：失败详情同样补载体 CLI 命令（不只限于三个宿主拒绝码）', async () => {
    const { manager, calls } = makeManager({
      installs: [ALREADY_INSTALLED],
      listBundles: [{ name: TARGET, installed: true, enabled: false, removable: true }],
      setBundleEnabled: { application: 'failed', error: { code: 'permission' } },
    })
    await assert.rejects(run(manager), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.match(error.detail, /permission/)
      assert.match(error.detail, /宿主写不了使用范围目录/)
      assert.ok(
        error.detail.includes(`dsh plugin --profile desktop add --save-exact ${SPEC} --registry=${REGISTRY}`),
        `启用失败也要给完整命令（含 --registry），实际：${error.detail}`
      )
      return true
    })
    assert.equal(calls.some((call) => call[0] === 'removeBundle'), false, '恢复选中没成就不能往下摘包')
  })

  it('恢复选中超时：人话格说明是启用步超时，并给载体 CLI 命令', async () => {
    const manager = {
      installBundle: () => ALREADY_INSTALLED,
      removeBundle: () => ({ application: 'applied' }),
      listBundles: () => [{ name: TARGET, installed: true, enabled: false, removable: true }],
      setBundleEnabled: () => new Promise(() => {}),
    }
    await assert.rejects(run(manager, { installTimeoutMs: 60 }), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.match(error.detail, /启用已装包超时/)
      assert.ok(
        error.detail.includes(`dsh plugin --profile desktop add --save-exact ${SPEC} --registry=${REGISTRY}`),
        `启用超时也要给完整命令（含 --registry），实际：${error.detail}`
      )
      return true
    })
  })

  it('目标包名很长时人话格仍守 300 字上限（命令本身超预算就只留原文，不越界）', async () => {
    const longTarget = 'x'.repeat(214)
    const manager = {
      installBundle(spec) {
        assert.ok(spec.startsWith(`${longTarget}@`))
        return manager.installs.shift()
      },
      installs: [ALREADY_INSTALLED, { application: 'failed', error: { code: 'disk-full' } }],
      removeBundle: () => ({ application: 'applied' }),
    }
    await assert.rejects(run(manager, { targetPackageName: longTarget }), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.ok(error.detail.length <= 300, `详情超 300：${error.detail.length}`)
      return true
    })
  })

  it('listBundles 抛错的宿主：退回旧两步（探测异常不冒充「不可用」，也不改用户拓扑）', async () => {
    const calls = []
    const manager = {
      installBundle(spec) {
        calls.push(['installBundle', spec])
        return calls.filter((call) => call[0] === 'installBundle').length === 1 ? ALREADY_INSTALLED : OK
      },
      removeBundle(name) {
        calls.push(['removeBundle', name])
        return { application: 'applied' }
      },
      listBundles() {
        calls.push(['listBundles'])
        throw new Error('probe exploded')
      },
    }
    await run(manager)
    assert.deepEqual(calls.map((call) => call[0]), ['installBundle', 'listBundles', 'removeBundle', 'installBundle'])
  })

  it('清单行缺 enabled/removable 格（异形/老宿主形状）⇒ 不拿缺省当否，退回旧两步', async () => {
    const calls = []
    const manager = {
      installBundle() {
        calls.push(['installBundle'])
        return calls.filter((call) => call[0] === 'installBundle').length === 1 ? ALREADY_INSTALLED : OK
      },
      removeBundle(name) {
        calls.push(['removeBundle', name])
        return { application: 'applied' }
      },
      listBundles() {
        calls.push(['listBundles'])
        return [{ name: TARGET, installed: true }]
      },
      setBundleEnabled() {
        calls.push(['setBundleEnabled'])
        return { changed: true, application: 'applied' }
      },
    }
    await run(manager)
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['installBundle', 'listBundles', 'removeBundle', 'installBundle'],
      '缺格时必须按旧行为走，不许误启用、也不许误报不可移除',
    )
  })

  it('载体命令的 profile 与源取配方自己的值，不写死 desktop（命令单源）', async () => {
    const manager = {
      installBundle: () => ALREADY_INSTALLED,
      removeBundle: () => ({ application: 'applied' }),
      listBundles: () => [{ name: TARGET, installed: true, enabled: true, removable: false }],
    }
    const executor = createUpdateExecutor({
      profileName: 'desktop',
      environmentKind: 'desktop-manager',
      targetPackageName: TARGET,
      registryUrl: REGISTRY,
      pluginManager: manager,
    })
    await assert.rejects(
      executor({ version: '2.0.0', profileName: 'work', environmentKind: 'desktop-manager' }),
      (error) => {
        assert.ok(
          error.detail.includes(`dsh plugin --profile work add --save-exact ${SPEC} --registry=${REGISTRY}`),
          `命令必须用配方自己的使用范围名与同源源地址，实际：${error.detail}`
        )
        return true
      }
    )
  })

  it('使用范围名含 shell 元字符：宁可不出命令，也不出会被展开/截断的假命令', async () => {
    const { manager } = makeManager({
      installs: [ALREADY_INSTALLED],
      listBundles: [{ name: TARGET, installed: true, enabled: true, removable: false }],
    })
    const executor = createUpdateExecutor({
      profileName: 'desktop',
      environmentKind: 'desktop-manager',
      targetPackageName: TARGET,
      registryUrl: REGISTRY,
      pluginManager: manager,
    })
    await assert.rejects(
      executor({ version: '2.0.0', profileName: 'my $profile', environmentKind: 'desktop-manager' }),
      (error) => {
        assert.match(error.detail, /不可移除/, '事实与下一步照旧给')
        assert.ok(!error.detail.includes('dsh plugin'), `不安全插值不许编命令，实际：${error.detail}`)
        return true
      }
    )
  })
})
