// tests/last-resort.test.mjs —— #174：「最后手段」纯派生判定的真值表（唯一判定源）。
// 判定消费现成事实（码/阶段/manual/manualSource/fallbackAvailable/运行版已知性），不改码面、不加快照字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { lastResortSubjectOf, rescueRoutesOf, lastResortVerdictOf } = await import('../dist/last-resort.js')
const { BLOCKED_REASONS, PHONE_FAILURE_CODES, CHECK_SIDE_FAILURE_CODES } = await import('../dist/shared/codes.js')

const kinds = new Set(['last-resort', 'salvageable', 'dead-end', 'unknown'])

function verdictOf(input) {
  const v = lastResortVerdictOf(input)
  assert.ok(v && typeof v === 'object', '判定结果必须是对象')
  assert.ok(kinds.has(v.kind), '四态之外不许出现：' + String(v.kind))
  assert.ok(Array.isArray(v.routes), 'routes 必须是数组')
  assert.ok(v.subject && typeof v.subject === 'object', 'subject 必须带码与阶段')
  assert.ok('code' in v.subject && 'stage' in v.subject, 'subject = 码 + 阶段')
  assert.ok(v.manualSource === null || v.manualSource === 'frame' || v.manualSource === 'carried-over')
  return v
}

// —— 安装失败：合规版通道是唯一的自动救援 ——
test('安装失败：有合规版候选 → salvageable（install-compliant），不判最后手段', () => {
  const v = verdictOf({ code: 'install-failed', fallbackAvailable: true, manual: 'cmd', manualSource: 'frame' })
  assert.equal(v.kind, 'salvageable')
  assert.deepEqual(v.routes, ['install-compliant'])
  assert.deepEqual(v.subject, { code: 'install-failed', stage: 'install', registered: null })
})

test('安装失败：无合规版 + 当帧可信命令 → last-resort（唯一高亮窗口）', () => {
  const v = verdictOf({ code: 'install-failed', fallbackAvailable: false, manual: 'cmd', manualSource: 'frame' })
  assert.equal(v.kind, 'last-resort')
  assert.deepEqual(v.routes, [])
})

test('安装失败：无合规版 + 无命令（当帧确认无命令）→ dead-end', () => {
  const v = verdictOf({ code: 'install-failed', fallbackAvailable: false, manual: null, manualSource: null })
  assert.equal(v.kind, 'dead-end')
  assert.deepEqual(v.routes, [])
})

test('安装失败：无合规版 + 遗留命令 → unknown（fail-closed，不高亮）', () => {
  const v = verdictOf({ code: 'install-failed', fallbackAvailable: false, manual: 'old cmd', manualSource: 'carried-over' })
  assert.equal(v.kind, 'unknown')
  assert.equal(v.manualSource, 'carried-over')
})

test('安装失败：命令字符串在但来源没标 → unknown（不猜可信）', () => {
  const v = verdictOf({ code: 'install-failed', fallbackAvailable: false, manual: 'cmd' })
  assert.equal(v.kind, 'unknown')
})

// —— 查侧三码：重新查询就是救援 ——
for (const code of CHECK_SIDE_FAILURE_CODES) {
  test('查侧失败 ' + code + ' → salvageable（recheck）', () => {
    const v = verdictOf({ code, manual: 'cmd', manualSource: 'frame' })
    assert.equal(v.kind, 'salvageable')
    assert.deepEqual(v.routes, ['recheck'])
    assert.equal(v.subject.stage, 'check')
  })
}

test('update-busy → salvageable（wait-retry）', () => {
  const v = verdictOf({ code: 'update-busy', manual: 'cmd', manualSource: 'frame' })
  assert.equal(v.kind, 'salvageable')
  assert.deepEqual(v.routes, ['wait-retry'])
  assert.equal(v.subject.stage, 'busy')
})

test('internal 与认不出的码 → unknown（不宣称无救）', () => {
  for (const code of ['internal', 'unsupported', 'cross-scope', 'made-up-code', '']) {
    const v = verdictOf({ code, manual: 'cmd', manualSource: 'frame' })
    assert.equal(v.kind, 'unknown', code + ' 必须 unknown')
    assert.deepEqual(v.routes, [])
  }
})

// —— 阻塞：11 个 BlockedReason 逐项映射（穷尽表） ——
const EXPECTED_BLOCKED = {
  'unknown-profile': { kind: 'dead-end', routes: [] },
  'source-install': { kind: 'dead-end', routes: [] },
  'dev-source': { kind: 'dead-end', routes: [] },
  'invalid-installation': { kind: 'dead-end', routes: [] },
  'recovery-required': { kind: 'dead-end', routes: [] },
  'installation-changed': { kind: 'salvageable', routes: ['recheck'] },
  'pending-restart': { kind: 'salvageable', routes: ['restart-host'] },
  'channel-mismatch': { kind: 'salvageable', routes: ['switch-channel'] },
  'registry-conflict': { kind: 'salvageable', routes: ['fix-manifest'] },
  'incompatible-node': { kind: 'salvageable', routes: ['upgrade-runtime'] },
  'incompatible-dsh': { kind: 'salvageable', routes: ['upgrade-runtime'] },
}

test('阻塞码表与规格逐项一致（11 项，穷尽）', () => {
  assert.deepEqual([...BLOCKED_REASONS].sort(), Object.keys(EXPECTED_BLOCKED).sort(), '新增阻塞码必须补判定表与测试')
})

for (const reason of BLOCKED_REASONS) {
  test('阻塞 ' + reason + ' → ' + EXPECTED_BLOCKED[reason].kind, () => {
    const v = verdictOf({ blockedReason: reason, code: reason, manual: 'cmd', manualSource: 'frame' })
    assert.equal(v.subject.stage, 'blocked')
    assert.equal(v.subject.code, reason)
    assert.equal(v.kind, EXPECTED_BLOCKED[reason].kind, reason + ' 的判定与规格不符')
    assert.deepEqual(v.routes, EXPECTED_BLOCKED[reason].routes, reason + ' 的救援路径与规格不符')
  })
}

test('阻塞码表穷尽：每种 BLOCKED_REASON 都判得出（不落 unknown）', () => {
  for (const reason of BLOCKED_REASONS) {
    const v = lastResortVerdictOf({ blockedReason: reason, manual: null, manualSource: null })
    assert.notEqual(v.kind, 'unknown', reason + ' 没有判定表条目')
  }
})

test('pending-restart 且 registered=false → select-in-host', () => {
  const v = verdictOf({ blockedReason: 'pending-restart', registered: false })
  assert.equal(v.kind, 'salvageable')
  assert.deepEqual(v.routes, ['select-in-host'])
})

// —— 运行版未知：先重查，不判无救 ——
test('运行版未知 + 无合规版 + 无命令 → salvageable（recheck）', () => {
  const v = verdictOf({ code: 'install-failed', fallbackAvailable: false, manual: null, manualSource: null, runningVersionKnown: false })
  assert.equal(v.kind, 'salvageable')
  assert.deepEqual(v.routes, ['recheck'])
})

// —— 码面遍历：三种电话失败码 + internal 都能判 ——
test('电话失败码全部有判定（新增码会红）', () => {
  for (const code of PHONE_FAILURE_CODES) {
    const withFrame = lastResortVerdictOf({ code, manual: 'cmd', manualSource: 'frame' })
    assert.notEqual(withFrame.kind, 'unknown', code + ' 没有判定分支')
  }
})

// —— 错误输入：一律 unknown，不抛 ——
test('错误输入 → unknown，不抛', () => {
  const inputs = [null, undefined, 0, 42, 'install-failed', [], {}, { code: 42 }, { code: '   ' }, { manual: 'cmd', manualSource: 'nope' }]
  for (const input of inputs) {
    const v = lastResortVerdictOf(input)
    assert.equal(v.kind, 'unknown', JSON.stringify(input) + ' 必须 unknown')
    assert.equal(v.subject.code, null)
    assert.equal(v.subject.stage, 'unknown')
    assert.deepEqual(v.routes, [])
  }
})

test('lastResortSubjectOf 对错误输入不抛', () => {
  for (const input of [null, undefined, 1, 'x', [], {}, { blockedReason: 42 }, { code: {} }]) {
    const s = lastResortSubjectOf(input)
    assert.equal(s.code, null)
    assert.equal(s.stage, 'unknown')
  }
})

test('rescueRoutesOf 对错误 subject 不抛，返回 []', () => {
  for (const subject of [null, undefined, 1, {}, { code: null, stage: 'unknown' }, { code: 'nope', stage: 'blocked' }]) {
    assert.deepEqual(rescueRoutesOf(subject), [])
  }
})

// —— 阶段推导：码 → 阶段是纯派生 ——
test('subject 阶段只由码推导（码面不动）', () => {
  assert.deepEqual(lastResortSubjectOf({ code: 'install-failed' }), { code: 'install-failed', stage: 'install', registered: null })
  assert.deepEqual(lastResortSubjectOf({ code: 'check-failed' }), { code: 'check-failed', stage: 'check', registered: null })
  assert.deepEqual(lastResortSubjectOf({ code: 'update-busy' }), { code: 'update-busy', stage: 'busy', registered: null })
  assert.deepEqual(lastResortSubjectOf({ blockedReason: 'pending-restart' }), { code: 'pending-restart', stage: 'blocked', registered: null })
  assert.deepEqual(lastResortSubjectOf({ code: 'internal' }), { code: 'internal', stage: 'unknown', registered: null })
})

// —— 合取规则：last-resort 与 salvageable/dead-end 互斥 ——
test('四态互斥：有救援时永不 last-resort；无可信命令时永不 last-resort', () => {
  const withRoute = lastResortVerdictOf({ code: 'check-failed', manual: null, manualSource: null })
  assert.equal(withRoute.kind, 'salvageable')
  const carried = lastResortVerdictOf({ blockedReason: 'source-install', manual: 'cmd', manualSource: 'carried-over' })
  assert.equal(carried.kind, 'unknown', '#177 D4：carried-over 一律 unknown，阻塞面也不例外')
  const empty = lastResortVerdictOf({ blockedReason: 'source-install', manual: '', manualSource: 'frame' })
  assert.equal(empty.kind, 'dead-end')
})
