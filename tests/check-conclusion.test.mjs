import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cc from '../dist/check-conclusion.js'

// #163 故事 3 收尾：检查结论编排（#124 五个纯 helper）从 service.ts 独立。
// 本测试先红：check-conclusion 尚不存在；实现后逐字冻结旧语义（从旧内联逐条抄断言）。

test('#163 检查结论：错误贴阶段（显式 stage 赢，无码认 fetch，有码认 verify）', async () => {
  assert.equal(typeof cc.stageOfError, 'function', '先红：check-conclusion 尚未导出 stageOfError')
  assert.equal(cc.stageOfError({ stage: 'fetch' }), 'fetch')
  assert.equal(cc.stageOfError({ stage: 'channel' }), 'channel')
  assert.equal(cc.stageOfError({ stage: 'bogus', code: 'check-failed' }), 'fetch')
  assert.equal(cc.stageOfError({ code: 'check-failed' }), 'fetch')
  assert.equal(cc.stageOfError({ code: 'other' }), 'verify')
  assert.equal(cc.stageOfError({}), 'verify')
  assert.equal(cc.stageOfError(null), 'verify')
})

test('#163 检查结论：稳定码与 HTTP 状态（无码 internal，非整数不要）', () => {
  assert.equal(cc.stableCodeOf({ code: 'install-failed' }), 'install-failed')
  assert.equal(cc.stableCodeOf({ code: '' }), 'internal')
  assert.equal(cc.stableCodeOf({}), 'internal')
  assert.equal(cc.stableCodeOf(null), 'internal')
  assert.equal(cc.httpStatusOfError({ httpStatus: 404 }), 404)
  assert.equal(cc.httpStatusOfError({ httpStatus: 1.5 }), null)
  assert.equal(cc.httpStatusOfError({}), null)
  assert.equal(cc.httpStatusOfError(null), null)
})

test('#163 检查结论：意图来源与触发方（认不出即默认，不猜）', () => {
  assert.equal(cc.installSourceOf('entry'), 'entry')
  assert.equal(cc.installSourceOf('batch'), 'batch')
  assert.equal(cc.installSourceOf('nope'), 'panel')
  assert.equal(cc.installSourceOf(null), 'panel')
  assert.equal(cc.triggerOf('auto'), 'auto')
  assert.equal(cc.triggerOf('user'), 'user')
  assert.equal(cc.triggerOf('batch'), 'batch')
  assert.equal(cc.triggerOf('entry'), 'entry')
  assert.equal(cc.triggerOf('nope'), null)
  assert.equal(cc.triggerOf(null), null)
})
