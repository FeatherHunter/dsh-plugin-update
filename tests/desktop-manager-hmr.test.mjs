/**
 * tests/desktop-manager-hmr.test.mjs —— 官方桌面版（进程内插件管理器）上「更新已装包」的配方。
 *
 * 真机故障（2026-10-17）：HMR 开着的官方桌面版里，管理器对**已在 profile dependencies 里**的包
 * 在跑 pnpm 之前就 resolve 出 `application:'failed'` + `error.code:'already-installed'`，
 * 宿主自己的 next-step 表写着 `already-installed → 先 remove_bundle 再 install_bundle`。
 * 本包此前只调 installBundle，于是已装的包永远更新不了（install-failed，管理器从未起过 pnpm 子进程）。
 *
 * 本文件是**独立于实现**的黑箱测试：断言照 task-3 的冻结契约写，不照实现反推。
 * 只从 `../dist/store.js` 的公开入口 `createUpdateExecutor` 进；管理器、日志、计时全用假件，
 * 不碰真机、不起进程、不联网、不读 asar。形状照 tests/desktop-manager.test.mjs。
 *
 * 未覆盖（经公开入口不可达）：冻结契约第 5 条后半句「spec 取不出包名」。公开入口的 spec 恒为
 * installRecipe 生成的 `<合法管理器包名>@<三段版本>`（src/commands.ts:163-168），
 * 「取不出包名」那一支在库内没有可观测入口——已报 lead，绝不为了凑覆盖率另造一个内部入口。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateExecutor, __executorInternals } from '../dist/store.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const SPEC = `${TARGET}@1.2.3`
const MANAGER_KIND = 'desktop-manager'
const REGISTRY = 'https://registry.npmjs.org/'

/** 首装超时那条冻结中文（src/store.ts:1487）。契约第 8 条以它为「必须不同」的基准。 */
const INSTALL_TIMEOUT_DETAIL = '安装超时，已请求宿主取消'
/** 终止宽限期：既有常量（src/store.ts:1053 的 3000ms），超时后宿主还会等它自己收尾这么久。 */
const GRACE_MS = __executorInternals.TERMINATION_GRACE_MS

/** 宿主对「已在 dependencies 里」的回包：预期失败不 reject，是 resolve 出来的。 */
const alreadyInstalled = (diagnostic = '已在 profile dependencies 里；next-step: remove_bundle first') => ({
  application: 'failed',
  error: { code: 'already-installed', diagnostic },
})

/**
 * 假管理器：按 script 逐次回话，并把每次调用的实参原样记下来。
 *   - script.install / script.remove 的项：回包对象｜Error（拒绝）｜函数（自己回，可用来挂起）；
 *     数组用完后 install 回 `{application:'applied'}`、remove 回 `{application:'applied'}`。
 *   - script.remove === false 即「假件没有 removeBundle」。
 * 这里只搬运，不解释：怎么用回包是本包被测实现的事。
 */
function scripted(script = {}) {
  const calls = { install: [], remove: [], cancel: [] }
  const next = (list, fallback) => (Array.isArray(list) && list.length > 0 ? list.shift() : fallback)
  const answer = (step) => {
    if (step instanceof Error) return Promise.reject(step)
    if (typeof step === 'function') return Promise.resolve().then(() => step())
    return Promise.resolve(step)
  }
  const manager = {
    calls,
    installBundle(spec, options) {
      calls.install.push({ spec, options })
      return answer(next(script.install, { application: 'applied' }))
    },
    cancelInstall(requestId) {
      calls.cancel.push(requestId)
      return Promise.resolve({ status: 'not-running' })
    },
  }
  if (script.remove !== false) {
    manager.removeBundle = (name) => {
      calls.remove.push([name])
      return answer(next(script.remove, { application: 'applied' }))
    }
  }
  return manager
}

const captureLog = () => {
  const fires = []
  return { fires, log: (level, event, fields) => fires.push({ level, event, fields }) }
}

/** 这次调用必须失败：把抛出的错原样交回；它若 resolve 就是测试失败（不许把失败当成功）。 */
async function rejectedOf(run) {
  let error = null
  let resolved = false
  try {
    await run()
    resolved = true
  } catch (caught) {
    error = caught
  }
  if (resolved) assert.fail('这次调用必须失败，但它 resolve 了')
  return error
}

/** 给一次调用套上硬上限：到点还没收场就回 hang，免得一个挂死的实现把整个测试吊住。 */
async function cappedSettle(run, capMs) {
  const HANG = Symbol('hang')
  const startedAt = Date.now()
  let timer = null
  try {
    const outcome = await Promise.race([
      run().then(
        () => ({ kind: 'resolved' }),
        (error) => ({ kind: 'failed', error })
      ),
      new Promise((settle) => {
        timer = setTimeout(() => settle(HANG), capMs)
      }),
    ])
    if (outcome === HANG) return { kind: 'hang', elapsed: Date.now() - startedAt }
    return { kind: outcome.kind, error: outcome.error, elapsed: Date.now() - startedAt }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

describe('官方桌面版：更新已装包的配方（remove_bundle → install_bundle，黑箱）', () => {
  const runWith = (parts) =>
    createUpdateExecutor({ environmentKind: MANAGER_KIND, profileName: 'desktop', pluginId: 'my-plugin', ...parts })
  const call = (runInstall, version = '1.2.3') =>
    runInstall({ version, profileName: 'desktop', environmentKind: MANAGER_KIND })

  it('已装：先按包名移除，再用新的 requestId 重装；最终成败只看第二次（三态都算成功）', async () => {
    for (const application of ['applied', 'restart-required', 'overridden']) {
      const manager = scripted({
        install: [alreadyInstalled(), { application }],
        remove: [{ application: 'applied' }],
      })
      const { fires, log } = captureLog()
      await call(runWith({ registryUrl: REGISTRY, pluginManager: manager, log }))

      assert.deepEqual(manager.calls.remove, [[TARGET]], '移除的实参必须是 spec 最后一个 @ 之前的包名，且只带这一个')
      assert.equal(manager.calls.install.length, 2, '第一次被拒后必须恰好再装一次')
      const [first, second] = manager.calls.install
      assert.equal(first.spec, SPEC)
      assert.equal(second.spec, SPEC, '第二次的 spec 与第一次一致')
      assert.equal(first.options.registry, REGISTRY)
      assert.equal(second.options.registry, REGISTRY, '第二次的源与第一次一致')
      assert.equal(typeof second.options.requestId, 'string')
      assert.ok(second.options.requestId.length > 0)
      assert.notEqual(second.options.requestId, first.options.requestId, '第二次必须是新的 requestId')

      const exec = fires.filter((f) => f.event === 'update.install.exec')
      assert.equal(exec.length, 1, '一次更新操作只留一行 update.install.exec')
      assert.equal(exec[0].fields.ok, true)
      assert.equal(exec[0].fields.route, MANAGER_KIND)
      assert.deepEqual(Object.keys(exec[0].fields).sort(), ['durationMs', 'exitCode', 'ok', 'pluginId', 'route'])
    }
  })

  it('没注入源：两次安装都不传源（与第一次的空形状一致）', async () => {
    const manager = scripted({ install: [alreadyInstalled(), { application: 'applied' }] })
    await call(runWith({ pluginManager: manager, log: () => {} }))
    assert.equal(manager.calls.install.length, 2)
    assert.equal('registry' in manager.calls.install[0].options, false)
    assert.equal('registry' in manager.calls.install[1].options, false)
    assert.notEqual(manager.calls.install[0].options.requestId, manager.calls.install[1].options.requestId)
  })

  it('作用域包名（spec 里两个 @）：移除拿的是 @s/n，不是空串也不是整串规格', async () => {
    const manager = scripted({ install: [alreadyInstalled(), { application: 'applied' }] })
    await call(runWith({ pluginManager: manager, targetPackageName: '@s/n', log: () => {} }))
    assert.deepEqual(manager.calls.remove, [['@s/n']])
    assert.deepEqual(
      manager.calls.install.map((entry) => entry.spec),
      ['@s/n@1.2.3', '@s/n@1.2.3']
    )
  })

  it('移除回 applied/restart-required/overridden 都算移除成功，继续重装', async () => {
    for (const application of ['applied', 'restart-required', 'overridden']) {
      const manager = scripted({
        install: [alreadyInstalled(), { application: 'applied' }],
        remove: [{ application }],
      })
      await call(runWith({ pluginManager: manager, log: () => {} }))
      assert.equal(manager.calls.install.length, 2, `移除回 ${application} 应当继续重装`)
    }
  })

  it('移除没回三态（cancelled / failed / 别的词 / undefined）：不许重装，按 install-failed 收场', async () => {
    const cases = [
      ['移除被取消', { application: 'cancelled' }],
      ['移除失败', { application: 'failed', error: { code: 'not-removable', diagnostic: '宿主原话-NOT-REMOVABLE' } }],
      ['没见过的词', { application: 'noop' }],
      ['undefined', undefined],
    ]
    for (const [what, reply] of cases) {
      const manager = scripted({ install: [alreadyInstalled()], remove: [reply] })
      const error = await rejectedOf(() => call(runWith({ pluginManager: manager, log: () => {} })))
      assert.equal(error.code, 'install-failed', `${what}：失败码`)
      assert.equal(manager.calls.install.length, 1, `${what}：不许有第二次安装`)
      if (what === 'undefined') {
        // 回 undefined 不是三态之一，不许因为读它的 application 而炸成一句运行时错。
        assert.ok(
          !/is not a function|Cannot read propert/.test(String(error.detail)),
          `移除回 undefined 不该炸出运行时错，实际详情：${String(error.detail)}`
        )
      }
    }
  })

  it('不是 already-installed 的失败：一次 removeBundle 都不许调', async () => {
    const cases = [
      ['普通失败', { application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm 报错' } }],
      ['被取消', { application: 'cancelled' }],
      ['失败但没给 error', { application: 'failed' }],
      ['近似的错误码（下划线）', { application: 'failed', error: { code: 'already_installed' } }],
      ['近似的错误码（后缀）', { application: 'failed', error: { code: 'already-installed-2' } }],
      [
        '只有原文里出现 already-installed（散文字样不算判据）',
        { application: 'failed', packageResult: { output: 'ERR_PNPM_ERR already-installed in profile dependencies' } },
      ],
    ]
    for (const [what, reply] of cases) {
      const manager = scripted({ install: [reply], remove: [() => assert.fail(`${what}：不许调 removeBundle`)] })
      const error = await rejectedOf(() => call(runWith({ pluginManager: manager, log: () => {} })))
      assert.equal(error.code, 'install-failed', `${what}：仍是 install-failed`)
      assert.equal(manager.calls.remove.length, 0, `${what}：一次 removeBundle 都不许调`)
      assert.equal(manager.calls.install.length, 1, `${what}：只装一次`)
    }

    // 反向：application 不是 failed 时，就算 error 里带着 already-installed 也不进配方（判据是两者的组合）。
    for (const application of ['applied', 'restart-required', 'overridden']) {
      const manager = scripted({ install: [{ application, error: { code: 'already-installed' } }] })
      await call(runWith({ pluginManager: manager, log: () => {} }))
      assert.equal(manager.calls.remove.length, 0, `${application} 是成功：不许移除`)
      assert.equal(manager.calls.install.length, 1)
    }
  })

  it('假件没有 removeBundle（或不是函数）：保持原行为——只装一次，详情带宿主原话', async () => {
    const noRemove = scripted({ install: [alreadyInstalled('宿主原话-ALREADY-1')], remove: false })
    const notAFunction = {
      calls: { install: [] },
      installBundle(spec, options) {
        notAFunction.calls.install.push({ spec, options })
        return Promise.resolve(alreadyInstalled('宿主原话-ALREADY-2'))
      },
      removeBundle: 'nope',
    }
    for (const [what, manager] of [
      ['没有 removeBundle', noRemove],
      ['removeBundle 不是函数', notAFunction],
    ]) {
      const error = await rejectedOf(() => call(runWith({ pluginManager: manager, log: () => {} })))
      assert.equal(error.code, 'install-failed', `${what}：失败码`)
      assert.equal(manager.calls.install.length, 1, `${what}：只调一次 installBundle`)
      assert.match(String(error.detail), /already-installed/, `${what}：详情带宿主回包里的稳定码`)
      assert.match(String(error.detail), /ALREADY-[12]/, `${what}：详情带宿主的 diagnostic 原话`)
    }
  })

  it('移除失败：不许再装第二次，详情带宿主原话（not-removable），且过脱敏与 300 字封顶', async () => {
    const manager = scripted({
      install: [alreadyInstalled()],
      remove: [
        {
          application: 'failed',
          error: { code: 'not-removable', diagnostic: `不能删 C:\\secret\\deep\\place ${'x'.repeat(400)}` },
        },
      ],
    })
    const error = await rejectedOf(() => call(runWith({ pluginManager: manager, log: () => {} })))
    assert.equal(error.code, 'install-failed')
    assert.match(String(error.detail), /not-removable/, '详情带宿主的原话')
    assert.ok(!String(error.detail).includes('C:\\secret'), '绝对路径必须脱敏')
    assert.ok(String(error.detail).length <= 301, '详情必须截断')
    assert.equal(manager.calls.install.length, 1, '移除失败后不许有第二次安装')
  })

  it('移除成功后第二次又被拒 already-installed：不许再移除再重试，装两次就收场', async () => {
    const manager = scripted({
      install: [
        alreadyInstalled('宿主原话-FIRST'),
        { application: 'failed', error: { code: 'already-installed', diagnostic: '宿主原话-SECOND' } },
      ],
      remove: [{ application: 'applied' }],
    })
    const error = await rejectedOf(() => call(runWith({ pluginManager: manager, log: () => {} })))
    assert.equal(error.code, 'install-failed')
    assert.equal(manager.calls.install.length, 2, '不能再多装一次（无限重试）')
    assert.equal(manager.calls.remove.length, 1, '也不能再移除一次')
    assert.match(String(error.detail), /SECOND/, '详情带第二次的宿主原话')
  })

  it('第二次安装失败：失败码 install-failed，详情说第二次为什么没装上', async () => {
    const manager = scripted({
      install: [
        alreadyInstalled('宿主原话-FIRST'),
        { application: 'failed', error: { code: 'operation-error', diagnostic: '第二次的错-SECOND' } },
      ],
      remove: [{ application: 'applied' }],
    })
    const error = await rejectedOf(() => call(runWith({ pluginManager: manager, log: () => {} })))
    assert.equal(error.code, 'install-failed')
    assert.match(String(error.detail), /operation-error/)
    assert.match(String(error.detail), /SECOND/)
    assert.ok(!String(error.detail).includes('FIRST'), '最终详情说的是第二次为什么没装上，不是最初的 already-installed 触发因')
    assert.equal(manager.calls.install.length, 2)
  })

  it('removeBundle 抛异常或拒绝：不炸出别的码，收成 install-failed，且不重装', async () => {
    const cases = [
      ['同步抛', new Error('remove 炸了')],
      ['拒绝', () => Promise.reject(new Error('remove 拒绝了'))],
    ]
    for (const [what, reply] of cases) {
      const manager = scripted({ install: [alreadyInstalled()], remove: [reply] })
      const error = await rejectedOf(() => call(runWith({ pluginManager: manager, log: () => {} })))
      assert.equal(error.code, 'install-failed', `${what}：失败码`)
      assert.equal(manager.calls.install.length, 1, `${what}：不重装`)
    }
  })

  it('成功时日志仍只有一条、字段集不变；新路的失败详情同样脱敏 + 300 字封顶', async () => {
    const manager = scripted({
      install: [alreadyInstalled(), { application: 'restart-required' }],
      remove: [{ application: 'applied' }],
    })
    const { fires, log } = captureLog()
    await call(runWith({ registryUrl: REGISTRY, pluginManager: manager, log }))
    const exec = fires.filter((f) => f.event === 'update.install.exec')
    assert.equal(exec.length, 1, '装了两次也还是一条日志行')
    assert.equal(exec[0].fields.ok, true)
    assert.equal(exec[0].fields.route, MANAGER_KIND)
    assert.equal(exec[0].fields.pluginId, 'my-plugin')
    assert.deepEqual(Object.keys(exec[0].fields).sort(), ['durationMs', 'exitCode', 'ok', 'pluginId', 'route'])

    const failing = scripted({
      install: [
        alreadyInstalled(),
        {
          application: 'failed',
          error: { code: 'operation-error', diagnostic: `pnpm 说装不上 C:\\secret\\deep\\place ${'x'.repeat(400)}` },
        },
      ],
      remove: [{ application: 'applied' }],
    })
    const error = await rejectedOf(() => call(runWith({ pluginManager: failing, log: () => {} })))
    assert.equal(error.code, 'install-failed')
    assert.ok(!String(error.detail).includes('C:\\secret'), '绝对路径必须脱敏')
    assert.ok(String(error.detail).length <= 301, '详情必须截断')
  })

  it('首装超时口径不变：详情仍是那条冻结中文，并请求宿主取消', async () => {
    const manager = scripted({ install: [() => new Promise(() => {})] })
    const outcome = await cappedSettle(
      () => call(runWith({ installTimeoutMs: 30, pluginManager: manager, log: () => {} })),
      30 + GRACE_MS + 4000
    )
    assert.equal(outcome.kind, 'failed', '首装挂死必须按超时收场')
    assert.equal(outcome.error.code, 'install-failed')
    assert.equal(
      outcome.error.detail,
      INSTALL_TIMEOUT_DETAIL,
      '首装超时那条冻结中文被改了（契约第 8 条以它为「必须不同」的基准）'
    )
    assert.equal(manager.calls.install.length, 1)
    assert.equal(manager.calls.remove.length, 0)
    assert.ok(manager.calls.cancel.length >= 1, '超时后要请求宿主取消')
    assert.equal(manager.calls.cancel[0], manager.calls.install[0].options.requestId, '取消要带本次安装的 requestId')
  })

  it('移除步超时：详情与「安装超时」那条不同，且看得出卡在移除这一步', async () => {
    const manager = scripted({ install: [alreadyInstalled()], remove: [() => new Promise(() => {})] })
    const outcome = await cappedSettle(
      () => call(runWith({ installTimeoutMs: 30, pluginManager: manager, log: () => {} })),
      30 + GRACE_MS + 4000
    )
    assert.equal(outcome.kind, 'failed', '移除挂死必须收场，不能干等宿主')
    assert.equal(outcome.error.code, 'install-failed')
    assert.equal(manager.calls.remove.length, 1, '移除步必须真的起了')
    assert.equal(manager.calls.install.length, 1, '移除超时后不许有第二次安装')
    assert.notEqual(String(outcome.error.detail), INSTALL_TIMEOUT_DETAIL, '契约第 8 条：移除步超时的详情必须与「安装超时」那条不同')
    assert.match(String(outcome.error.detail), /移除/, '契约第 8 条：详情必须看得出是「移除」这一步')
  })

  it('超时预算是整个更新操作的：首装吃掉一部分，移除只拿剩下的（不是每步各给一份）', async () => {
    const BUDGET = 2000
    const CONSUMED = 1500
    const CAP = BUDGET + GRACE_MS + 4000
    const scenario = async (consumedMs) => {
      const manager = scripted({
        install: [
          () =>
            new Promise((settle) => {
              setTimeout(() => settle(alreadyInstalled()), consumedMs)
            }),
        ],
        remove: [() => new Promise(() => {})],
      })
      const outcome = await cappedSettle(
        () => call(runWith({ installTimeoutMs: BUDGET, pluginManager: manager, log: () => {} })),
        CAP
      )
      return { manager, outcome }
    }

    const zero = await scenario(0)
    const eaten = await scenario(CONSUMED)
    for (const [what, run] of [
      ['首装不吃预算', zero],
      [`首装吃掉 ${CONSUMED}ms`, eaten],
    ]) {
      assert.equal(run.outcome.kind, 'failed', `${what}：移除步必须按超时收场（实际 ${run.outcome.kind}）`)
      assert.match(String(run.outcome.error.detail), /移除/, `${what}：详情要看出卡在移除`)
      assert.equal(run.manager.calls.install.length, 1, `${what}：移除超时后不许有第二次安装`)
    }
    // 共享预算：两次的收场时刻都锚在「操作开始 + 预算（+宿主宽限期）」上，差不了多少；
    // 每步各给一份预算（或进了更新配方才起算），首装吃掉的那 1500ms 会整块推到收场时刻上。
    // 用「两次之差」当判据，宽限期在两次里都出现、相减即消——它是不是 3000ms 都不影响结论。
    // 阈值取信号（1500ms）的一半：判据不动，余量留给并发全量门禁下的计时抖动。
    assert.ok(zero.outcome.elapsed >= BUDGET - 100, `移除步该等到预算用完才收场（实测 ${zero.outcome.elapsed}ms）`)
    assert.ok(
      eaten.outcome.elapsed - zero.outcome.elapsed < 750,
      `移除步拿到的该是剩下的预算，不是新的一份（首装多吃 ${CONSUMED}ms 让收场晚了 ${eaten.outcome.elapsed - zero.outcome.elapsed}ms）`
    )
    assert.ok(
      eaten.outcome.elapsed < BUDGET + GRACE_MS + 500,
      `整个更新操作该在预算 + 宽限期内收场（实测 ${eaten.outcome.elapsed}ms）`
    )
  })
})
