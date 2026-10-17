/**
 * tests/issue-201-manager-recovery.test.mjs —— 管理器路：已装包的拓扑修复与诚实兜底（#201，S1）。
 *
 * 背景（真机 2026-10-18 01:25，五个插件 + im-companion 全部 2–3ms 失败 `bundle-in-use`）：
 * 官方桌面版的 `removeBundle` 只对**选中**的 bundle 先取消选中再重载卸载；装着、也在跑、
 * 却不在 `dsh.profile.bundles` 选中名单里的包，卸载永远判 `bundle-in-use`——两步配方走不完，
 * 升级永久失败。修形：移除前先探宿主拓扑（`listBundles`），不可移除就诚实拒绝；未选中就用
 * 宿主能力恢复选中（`setBundleEnabled`），再走移除+重装。
 *
 * 钉死的契约（直接跑执行器 `dist/store.js`，假管理器记录调用序列）：
 * 1. 未选中 + 可移除 ⇒ 先 `setBundleEnabled(name, true)`，再 remove→install，成功；
 * 2. 已选中 ⇒ 不碰选中名单，直接 remove→install（旧行为不变）；
 * 3. 不可移除 ⇒ 不调 remove，诚实失败，细节带宿主码 + 中文下一步 + 载体 CLI 命令；
 * 4. 宿主没有 `listBundles`（老宿主）⇒ 退回旧两步，成功；
 * 5. 有探测但没 `setBundleEnabled` ⇒ 不调 remove，诚实失败并在细节里给手工命令；
 * 6. 清单行缺 `enabled` / `removable` 格（异形老宿主形状）⇒ 不拿缺省当否，退回旧两步。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateExecutor } from '../dist/store.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const SPEC = `${TARGET}@2.0.0`
const PROFILE = 'desktop'

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

function run(manager) {
  const executor = createUpdateExecutor({
    profileName: PROFILE,
    environmentKind: 'desktop-manager',
    targetPackageName: TARGET,
    pluginManager: manager,
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
      assert.match(error.detail, /dsh plugin --profile desktop add --save-exact/, '必须给一条一定能用的命令')
      assert.match(error.detail, new RegExp(SPEC.replace(/[/.]/g, '\\$&')))
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
      assert.match(error.detail, /bundle-in-use/)
      assert.match(error.detail, /dsh plugin --profile desktop add --save-exact/)
      return true
    })
    assert.equal(calls.some((call) => call[0] === 'removeBundle'), false)
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
})
