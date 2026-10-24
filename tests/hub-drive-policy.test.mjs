/**
 * tests/hub-drive-policy.test.mjs —— 更新中枢 T1：推进策略是纯判决（issue #247 的一部分）。
 *
 * 黑盒视角回答一个问题：一轮推进循环停下之后，中枢到底该做什么？把答案压成四种动作：
 * 续跑（continue）、让位（yield）、收尾（settle）、报故障（fail）。
 *
 * 这里守的是「序列不许停在半路」：预算用完/外部边界挡了一下必须续跑；队列里装着别家只让位、
 * 不报错；真收尾才收尾；驱动器自身出错或长期无进展要如实报故障。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HUB_MAX_IDLE_STEPS,
  HUB_MAX_STEPS_PER_CYCLE,
  decideHubCycleVerdict,
} from '../dist/core/hub/drive-policy.js'

function facts(overrides = {}) {
  return { sessionFinished: false, stoppedBecause: 'max-steps', stepsTaken: 1, consecutiveNoProgress: 0, ...overrides }
}

describe('#247 中枢推进策略（纯判决）', () => {
  it('预算/外部边界挡下 → 续跑', () => {
    assert.equal(decideHubCycleVerdict(facts({ stoppedBecause: 'max-steps' })), 'continue')
  })

  it('队列里装着别家 / 暂时轮不到 → 让位（不是失败）', () => {
    assert.equal(decideHubCycleVerdict(facts({ stoppedBecause: 'queued' })), 'yield')
    assert.equal(decideHubCycleVerdict(facts({ stoppedBecause: 'empty' })), 'yield')
  })

  it('序列真收尾 / 失败后收尾 → settle', () => {
    assert.equal(decideHubCycleVerdict(facts({ sessionFinished: true, stoppedBecause: 'finished' })), 'settle')
    assert.equal(decideHubCycleVerdict(facts({ stoppedBecause: 'finished' })), 'settle')
    assert.equal(decideHubCycleVerdict(facts({ stoppedBecause: 'stopped-after-failure' })), 'settle')
  })

  it('用户取消/驱动错误/未知原因 → 报故障', () => {
    for (const stoppedBecause of ['user-cancel', 'error', 'mystery']) {
      assert.equal(decideHubCycleVerdict(facts({ stoppedBecause })), 'fail')
    }
  })

  it('步数吃满预算 → 故障（防一次通话跑完历史所有债）', () => {
    assert.equal(decideHubCycleVerdict(facts({ stepsTaken: HUB_MAX_STEPS_PER_CYCLE })), 'fail')
    assert.equal(decideHubCycleVerdict(facts({ stepsTaken: HUB_MAX_STEPS_PER_CYCLE + 5 })), 'fail')
    assert.equal(decideHubCycleVerdict(facts({ stepsTaken: 1 })), 'continue')
  })

  it('连续无进展 → 故障（防同一目标把队列饿死）', () => {
    assert.equal(decideHubCycleVerdict(facts({ consecutiveNoProgress: HUB_MAX_IDLE_STEPS })), 'fail')
    assert.equal(decideHubCycleVerdict(facts({ consecutiveNoProgress: 2 })), 'continue')
  })

  it('收尾优先：步数刚好用满但序列已收尾，仍按收尾处理', () => {
    assert.equal(
      decideHubCycleVerdict(facts({ sessionFinished: true, stepsTaken: HUB_MAX_STEPS_PER_CYCLE, stoppedBecause: 'max-steps' })),
      'settle',
    )
  })

  it('调用方可调小上限，坏上限退回默认', () => {
    assert.equal(decideHubCycleVerdict(facts({ stepsTaken: 1 }), { maxStepsPerCycle: 1 }), 'fail')
    assert.equal(decideHubCycleVerdict(facts({ consecutiveNoProgress: 2 }), { maxIdleSteps: 2 }), 'fail')
    assert.equal(decideHubCycleVerdict(facts({ stepsTaken: 1 }), { maxStepsPerCycle: 0 }), 'continue')
  })

  it('坏输入不抛，保守判故障', () => {
    assert.equal(decideHubCycleVerdict(null), 'fail')
    assert.equal(decideHubCycleVerdict({}), 'fail')
    assert.equal(decideHubCycleVerdict(facts({ stepsTaken: 'x', consecutiveNoProgress: -3 })), 'continue')
  })
})
