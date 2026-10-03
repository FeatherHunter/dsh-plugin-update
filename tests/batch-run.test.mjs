/**
 * tests/batch-run.test.mjs —— 批量串行驱动器（#25）。
 *
 * 只测外部行为：串行顺序（一家收尾才起下一家）、失败继续/停、幂等编号传给安装、
 * 每步落盘（断点续跑的全部依据）、只推进一步（drain 用）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { batchEntryOf, createBatchSession, resumeBatchSession } from '../dist/batch.js'
import { runBatch } from '../dist/batch-run.js'

function session(overrides = {}) {
  return createBatchSession({ id: 'b1', keys: ['alpha', 'beta', 'self'], selfKey: 'self', now: 1000, ...overrides })
}

/** 假件：记录每一次查/装/落盘，按传入的表给结果。 */
function fakeDeps(plan = {}) {
  const calls = { check: [], install: [], saved: [] }
  let clock = 2000
  return {
    calls,
    deps: {
      check: async (key) => {
        calls.check.push(key)
        const p = plan[key] ?? { kind: 'update', version: '2.0.0' }
        return p.check ?? p
      },
      install: async (key, requestId, version) => {
        calls.install.push({ key, requestId, version })
        const p = plan[key] ?? { kind: 'update', version: '2.0.0' }
        return p.install ?? { kind: 'done', restartRequired: false }
      },
      save: (s) => {
        calls.saved.push(JSON.parse(JSON.stringify(s)))
      },
      now: () => (clock += 10),
    },
  }
}

describe('串行顺序：一家收尾才起下一家', () => {
  it('检查顺序＝会话顺序，且自己排在最后', async () => {
    const { deps, calls } = fakeDeps()
    const r = await runBatch(session(), deps)
    assert.deepEqual(calls.check, ['alpha', 'beta', 'self'])
    assert.deepEqual(calls.install.map((i) => i.key), ['alpha', 'beta', 'self'])
    assert.equal(r.stoppedBecause, 'finished')
    assert.equal(r.steps.length, 6, '三家各一步查 + 一步装')
  })

  it('装上没装的不会插队（查完一家立刻装，再查下一家）', async () => {
    const { deps, calls } = fakeDeps()
    await runBatch(session(), deps)
    // 交错顺序：查 a、装 a、查 b、装 b、查 self、装 self
    assert.deepEqual(calls.check, ['alpha', 'beta', 'self'])
    assert.equal(calls.saved.length >= 6, true, '每一步都落盘')
  })

  it('把幂等编号原样交给安装（重复提交由队列去重）', async () => {
    const { deps, calls } = fakeDeps()
    const s = session()
    await runBatch(s, deps)
    assert.deepEqual(
      calls.install.map((i) => i.requestId),
      ['batch:b1:alpha', 'batch:b1:beta', 'batch:b1:self'],
    )
  })
})

describe('三种「不需要装」都不进安装', () => {
  it('已是最新 → current，不装', async () => {
    const { deps, calls } = fakeDeps({ alpha: { check: { kind: 'current' } } })
    const r = await runBatch(session(), deps)
    assert.equal(batchEntryOf(r.session, 'alpha').phase, 'current')
    assert.deepEqual(calls.install.map((i) => i.key), ['beta', 'self'])
  })

  it('被跳过 → skipped，不装（也不算失败）', async () => {
    const { deps, calls } = fakeDeps({ beta: { check: { kind: 'skipped', version: '2.0.0' } } })
    const r = await runBatch(session(), deps)
    assert.equal(batchEntryOf(r.session, 'beta').phase, 'skipped')
    assert.equal(r.stoppedBecause, 'finished')
    assert.deepEqual(FAILED(r.session), [])
  })

  it('查失败 → failed，默认继续下一家', async () => {
    const { deps, calls } = fakeDeps({ alpha: { check: { kind: 'failed', error: 'check-failed' } } })
    const r = await runBatch(session(), deps)
    assert.equal(batchEntryOf(r.session, 'alpha').phase, 'failed')
    assert.equal(batchEntryOf(r.session, 'alpha').error, 'check-failed')
    assert.deepEqual(calls.check, ['alpha', 'beta', 'self'], '默认策略：继续下一家')
    assert.deepEqual(calls.install.map((i) => i.key), ['beta', 'self'])
  })

  it('装失败 → failed，继续下一家', async () => {
    const { deps, calls } = fakeDeps({ beta: { install: { kind: 'failed', error: 'install-failed' } } })
    const r = await runBatch(session(), deps)
    assert.equal(batchEntryOf(r.session, 'beta').phase, 'failed')
    assert.equal(batchEntryOf(r.session, 'beta').error, 'install-failed')
    assert.deepEqual(calls.check, ['alpha', 'beta', 'self'])
  })
})

describe('stopOnFailure：一遇失败就停', () => {
  it('查失败即停，后面的不碰', async () => {
    const { deps, calls } = fakeDeps({ alpha: { check: { kind: 'failed', error: 'check-failed' } } })
    const r = await runBatch(session({ stopOnFailure: true }), deps)
    assert.equal(r.stoppedBecause, 'stopped-after-failure')
    assert.deepEqual(calls.check, ['alpha'])
    assert.equal(batchEntryOf(r.session, 'beta').phase, 'pending')
  })

  it('装失败即停', async () => {
    const { deps, calls } = fakeDeps({ alpha: { install: { kind: 'failed', error: 'install-failed' } } })
    const r = await runBatch(session({ stopOnFailure: true }), deps)
    assert.equal(r.stoppedBecause, 'stopped-after-failure')
    assert.deepEqual(calls.install.map((i) => i.key), ['alpha'])
    assert.equal(batchEntryOf(r.session, 'beta').phase, 'pending')
  })
})

describe('每步落盘：断点续跑的全部依据', () => {
  it('最后一份落盘就是返回的会话', async () => {
    const { deps, calls } = fakeDeps()
    const r = await runBatch(session(), deps)
    assert.deepEqual(calls.saved[calls.saved.length - 1], JSON.parse(JSON.stringify(r.session)))
  })

  it('落盘里能看到「这一家查过/装过」的中间态（被打断也知道走到哪）', async () => {
    const { deps, calls } = fakeDeps()
    await runBatch(session(), deps)
    const phases = calls.saved.map((s) => batchEntryOf(s, 'alpha').phase)
    assert.ok(phases.includes('checking'), '查之前先记 checking')
    assert.ok(phases.includes('ready'), '查到新版记 ready')
    assert.ok(phases.includes('installing'), '提交安装记 installing')
    const last = calls.saved[calls.saved.length - 1]
    assert.ok(last.entries.every((e) => e.phase !== 'pending'), '最后一次落盘时三家都动过了')
  })

  it('装完带 restartRequired：要重启的那几家记得住', async () => {
    const { deps } = fakeDeps({ self: { install: { kind: 'done', restartRequired: true } } })
    const r = await runBatch(session(), deps)
    assert.equal(batchEntryOf(r.session, 'self').restartRequired, true)
    assert.equal(batchEntryOf(r.session, 'alpha').restartRequired, false)
  })
})

describe('maxSteps：只推进一步（drain 按自己的节奏走）', () => {
  it('maxSteps=1 只做一次查，其余不动', async () => {
    const { deps, calls } = fakeDeps()
    const r = await runBatch(session(), deps, { maxSteps: 1 })
    assert.equal(r.stoppedBecause, 'max-steps')
    assert.deepEqual(calls.check, ['alpha'])
    assert.deepEqual(calls.install, [])
    assert.equal(batchEntryOf(r.session, 'alpha').phase, 'ready')
  })

  it('一步一推，推到底仍然是 finished', async () => {
    const { deps } = fakeDeps()
    let s = session()
    let guard = 0
    while (guard++ < 20) {
      const r = await runBatch(s, deps, { maxSteps: 1 })
      s = r.session
      if (r.stoppedBecause === 'finished') break
    }
    assert.equal(batchEntryOf(s, 'self').phase, 'done')
    assert.equal(batchEntryOf(s, 'alpha').phase, 'done')
  })
})

describe('断点续跑：跑一半被打断，读回来接着走且不重装', () => {
  it('第二次跑只处理没做完的那家', async () => {
    const first = fakeDeps()
    const half = await runBatch(session(), first.deps, { maxSteps: 2 })
    assert.equal(batchEntryOf(half.session, 'alpha').phase, 'done')
    assert.equal(batchEntryOf(half.session, 'beta').phase, 'pending')

    const second = fakeDeps()
    const rest = await runBatch(resumeBatchSession(half.session, 9000), second.deps)
    assert.equal(rest.stoppedBecause, 'finished')
    assert.deepEqual(second.calls.check, ['beta', 'self'], '已完成的不再查、不再装')
    assert.deepEqual(second.calls.install.map((i) => i.key), ['beta', 'self'])
  })

  it('被打断在 installing 的那家：续跑时重查再装，编号不变（幂等）', async () => {
    const first = fakeDeps({ beta: { install: { kind: 'failed', error: 'boom' } } })
    const broken = await runBatch(session(), first.deps, { maxSteps: 3 })
    // 手工把 beta 摆回「装到一半被打断」的样子
    const interrupted = {
      ...broken.session,
      entries: broken.session.entries.map((e) => (e.key === 'beta' ? { ...e, phase: 'installing', error: null } : e)),
    }
    const second = fakeDeps()
    const done = await runBatch(resumeBatchSession(interrupted, 9500), second.deps)
    const betaCall = second.calls.install.find((i) => i.key === 'beta')
    assert.equal(betaCall.requestId, 'batch:b1:beta', '续跑用的还是同一个幂等编号')
    assert.equal(batchEntryOf(done.session, 'beta').phase, 'done')
  })
})

describe('空会话与坏输入', () => {
  it('空会话：没活可干，不算 finished', async () => {
    const { deps } = fakeDeps()
    const r = await runBatch(createBatchSession({ id: 'b9', keys: [], now: 1 }), deps)
    assert.equal(r.stoppedBecause, 'empty')
    assert.deepEqual(r.steps, [])
  })
})

function FAILED(s) {
  return s.entries.filter((e) => e.phase === 'failed').map((e) => e.key)
}

describe('入队：忙时排队不是失败（一个一个加入队列那条路）', () => {
  it('装电话回 queued：相位退回 ready、不算 failed、本轮停下', async () => {
    const { deps } = fakeDeps({ alpha: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'queued', position: 1 } } })
    const r = await runBatch(session(), deps)
    assert.equal(r.stoppedBecause, 'queued', '停下等下一轮，不继续推下一家')
    assert.equal(batchEntryOf(r.session, 'alpha').phase, 'ready', '排上队但没轮到：回 ready（版本留着）')
    assert.equal(batchEntryOf(r.session, 'alpha').error, null, '入队不是失败，不许写 error')
    assert.notEqual(batchEntryOf(r.session, 'alpha').phase, 'failed')
    assert.equal(batchEntryOf(r.session, 'alpha').targetVersion, '2.0.0', '远端版本要留着')
    assert.deepEqual(r.steps, [
      { key: 'alpha', action: 'check', phase: 'ready', error: null },
      { key: 'alpha', action: 'install', phase: 'queued', error: null },
    ])
  })

  it('排队后下一轮接着装（幂等编号不变），不会被记成失败', async () => {
    const first = fakeDeps({ alpha: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'queued', position: 1 } } })
    const half = await runBatch(session(), first.deps)
    const second = fakeDeps()
    const rest = await runBatch(half.session, second.deps)
    assert.equal(rest.stoppedBecause, 'finished')
    assert.deepEqual(second.calls.check, ['beta', 'self'], '排队那家已是 ready，直接进安装不重查；其余照常查')
    assert.deepEqual(second.calls.install.map((i) => i.requestId), ['batch:b1:alpha', 'batch:b1:beta', 'batch:b1:self'], '编号恒定')
    assert.equal(batchEntryOf(rest.session, 'alpha').phase, 'done')
  })

  it('入队不触发 stopOnFailure 的停（它不是失败）', async () => {
    const { deps } = fakeDeps({ alpha: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'queued', position: 2 } } })
    const r = await runBatch(session({ stopOnFailure: true }), deps)
    assert.equal(r.stoppedBecause, 'queued', '停下是因为排队，不是因为遇错')
    assert.equal(batchEntryOf(r.session, 'alpha').phase, 'ready')
  })
})
