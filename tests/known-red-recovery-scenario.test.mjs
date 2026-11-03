/**
 * tests/known-red-recovery-scenario.test.mjs —— #284 A 组四场景的 hermetic 定向测试。
 *
 * 只测不依赖真机的纯函数：宿主 HMR profile patch 的幂等写入、电话桥不可用判定、
 * 「等效宿主说明」字段的完整性与模式区分。真机证明在仓库外（runtime/t12-284）跑，不在本测试里。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyHmrPatch,
  bridgeGoneOf,
  equivalentHostFactsOf,
} from '../selftest/real-machine/scenarios/known-red-recovery.ts'

const EMPTY_ARRAY_PATCH = '# Edit this file.\n[]\n'

test('applyHmrPatch：空数组占位 [] 被替换为 hmr 停用块（不是追加成非法 YAML）', () => {
  const patched = applyHmrPatch(EMPTY_ARRAY_PATCH)
  assert.equal(patched.changed, true)
  assert.match(patched.after, /^- id: hmr$/m)
  assert.match(patched.after, /^  disabled: true$/m)
  assert.doesNotMatch(patched.after, /\[\]/)
  // 原注释保留
  assert.match(patched.after, /Edit this file/)
})

test('applyHmrPatch：已有 hmr 条目时幂等（第二次不再改）', () => {
  const first = applyHmrPatch(EMPTY_ARRAY_PATCH)
  const second = applyHmrPatch(first.after)
  assert.equal(second.changed, false)
  assert.equal(second.after, first.after)
})

test('applyHmrPatch：已有其它 patch 条目时保留内容并追加', () => {
  const before = '# 已有配置\n- id: other\n  disabled: false\n'
  const patched = applyHmrPatch(before)
  assert.equal(patched.changed, true)
  assert.match(patched.after, /- id: other/)
  assert.match(patched.after, /^- id: hmr$/m)
})

test('applyHmrPatch：块里写明是宿主文档化入口（不是产品后门）', () => {
  const patched = applyHmrPatch(EMPTY_ARRAY_PATCH)
  assert.match(patched.after, /profile patch/)
  assert.match(patched.after, /dsh-hmr/)
})

test('bridgeGoneOf：404/405 都算桥不存在，200/500/null 不算', () => {
  assert.equal(bridgeGoneOf(404), true)
  assert.equal(bridgeGoneOf(405), true)
  assert.equal(bridgeGoneOf(200), false)
  assert.equal(bridgeGoneOf(500), false)
  assert.equal(bridgeGoneOf(null), false)
})

const MODES = ['f2', 'f3', 'g8', 'i4', 'can-red']

test('equivalentHostFactsOf：五个模式都给出完整等效宿主说明', () => {
  for (const mode of MODES) {
    const facts = equivalentHostFactsOf(mode)
    assert.ok(facts.what.length > 10, mode + ' 缺 what')
    assert.ok(facts.why.length > 10, mode + ' 缺 why')
    assert.match(facts.documentedEntry, /readerOverrides/, mode + ' 未写文档化入口')
    assert.ok(facts.realParts.length >= 3, mode + ' realParts 太少')
    assert.ok(facts.simulatedParts.length >= 1, mode + ' 缺 simulatedParts（不能只讲真的）')
    assert.ok(facts.nonEquivalence.length >= 1, mode + ' 缺 nonEquivalence 边界')
  }
})

test('equivalentHostFactsOf：模式专属事实不串味', () => {
  assert.match(equivalentHostFactsOf('f3').what, /失败/)
  assert.match(equivalentHostFactsOf('g8').what, /cancelInstall/)
  assert.match(equivalentHostFactsOf('i4').what, /runningVersion/)
  assert.match(equivalentHostFactsOf('can-red').what, /stale-variant/)
  assert.match(equivalentHostFactsOf('f2').what, /成功/)
  // i4 的等效说明必须提到 HMR 关闭（否则待重启状态不可达）
  assert.match(equivalentHostFactsOf('i4').why, /HMR/)
  const i4Simulated = equivalentHostFactsOf('i4').simulatedParts.join('；')
  assert.match(i4Simulated, /runningVersion/)
})
