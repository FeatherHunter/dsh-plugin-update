/**
 * tests/compliant-version.test.mjs —— #156 合规版决议（纯函数真值表）。
 *
 * 只走公开口（dist/host.js 转出口的 resolveCompliantVersion）：不测内部实现。
 * 五裁决 × 窗口出处 × 候选三锁 × 弃权条件；时间只锁相对关系（age >= window 即合规，
 * 边界取等），不锁墙钟；输入时间表里的坏条目一律忽略，不整表作废。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCompliantVersion } from '../dist/host.js'

// 现场实证数（dshmarket@1.66.28，2026-10-16 四家连锁失败的报文结构）。
const PUBLISHED = Date.parse('2026-10-16T05:58:34.000Z')
const DAY = 24 * 60 * 60_000
const WINDOW_MS = 1440 * 60_000
const UNLOCK = PUBLISHED + WINDOW_MS
// NOW_EARLY：发布后 1 小时（还差 23 小时满门限）；NOW_FREE：解封后 1 小时。
const NOW_EARLY = PUBLISHED + 60 * 60_000
const NOW_FREE = UNLOCK + 60 * 60_000

function baseInput(overrides = {}) {
  return {
    kind: 'minimum-release-age',
    blame: 'target',
    targetVersion: '1.66.28',
    latestVersion: '1.66.28',
    runningVersion: '1.66.25',
    releaseChannel: 'stable',
    windowMs: WINDOW_MS,
    windowSource: 'message',
    publishedAtMs: PUBLISHED,
    timeTable: {
      '1.66.28': PUBLISHED,
      '1.66.27': PUBLISHED - 2 * DAY,
      '1.66.26': PUBLISHED - 3 * DAY,
    },
    nowMs: NOW_EARLY,
    ...overrides,
  }
}

describe('compliant-version 真值表', () => {
  it('最新版已满门限 → ok-now（点名该版 + 解封时刻 + 出处）', () => {
    const out = resolveCompliantVersion(baseInput({ nowMs: NOW_FREE }))
    assert.equal(out.kind, 'ok-now')
    assert.equal(out.version, '1.66.28')
    assert.equal(out.unlockAtMs, UNLOCK)
    assert.equal(out.windowSource, 'message')
  })

  it('最新版未满、老版有合规 → downgrade-available（候选 + 目标解封）', () => {
    const out = resolveCompliantVersion(baseInput())
    assert.equal(out.kind, 'downgrade-available')
    assert.equal(out.version, '1.66.27')
    assert.equal(out.targetVersion, '1.66.28')
    assert.equal(out.targetUnlockAtMs, UNLOCK)
    assert.equal(out.windowSource, 'message')
  })

  it('最新版未满、无老版合规 → wait-until（只给时间，不编版本）', () => {
    const out = resolveCompliantVersion(
      baseInput({ timeTable: { '1.66.28': PUBLISHED }, runningVersion: '1.66.27' }),
    )
    assert.equal(out.kind, 'wait-until')
    assert.equal(out.version, '1.66.28')
    assert.equal(out.unlockAtMs, UNLOCK)
  })

  it('窗口已知但目标发布时间未知、又无老版合规 → no-compliant（不等同于 wait）', () => {
    const out = resolveCompliantVersion(
      baseInput({
        publishedAtMs: null,
        timeTable: { '1.66.28': null, '1.66.27': NOW_EARLY - 60_000 },
        runningVersion: '1.66.26',
      }),
    )
    assert.equal(out.kind, 'no-compliant')
    assert.equal(out.version, '1.66.28')
  })

  it('目标发布时间未知、但老版有合规 → downgrade-available 且目标解封为 null（不编时间）', () => {
    const out = resolveCompliantVersion(
      baseInput({ publishedAtMs: null, timeTable: { '1.66.27': PUBLISHED - 2 * DAY } }),
    )
    assert.equal(out.kind, 'downgrade-available')
    assert.equal(out.version, '1.66.27')
    assert.equal(out.targetUnlockAtMs, null)
  })

  it('归因不是主包 → abstain（B 类不决议）', () => {
    for (const blame of ['other-package', 'unknown']) {
      const out = resolveCompliantVersion(baseInput({ blame }))
      assert.equal(out.kind, 'abstain')
    }
  })

  it('没见过的 kind → abstain（只认见过且有机器编码的）', () => {
    const out = resolveCompliantVersion(baseInput({ kind: 'some-future-kind' }))
    assert.equal(out.kind, 'abstain')
  })

  it('窗口未知 → abstain（永不硬编码策略时长）', () => {
    const out = resolveCompliantVersion(baseInput({ windowMs: null }))
    assert.equal(out.kind, 'abstain')
  })

  it('时间表空无可用 → abstain（不是 no-compliant：连评都评不了）', () => {
    const out = resolveCompliantVersion(baseInput({ timeTable: {}, publishedAtMs: null }))
    assert.equal(out.kind, 'abstain')
  })

  it('目标不是 latest → abstain（本模型只覆盖最新版被拦）', () => {
    const out = resolveCompliantVersion(baseInput({ targetVersion: '1.66.27' }))
    assert.equal(out.kind, 'abstain')
  })

  it('目标是预发布（stable 通道）→ abstain', () => {
    const out = resolveCompliantVersion(
      baseInput({ targetVersion: '2.0.0-beta.1', latestVersion: '2.0.0-beta.1' }),
    )
    assert.equal(out.kind, 'abstain')
  })

  it('候选三锁：不比运行版新的一律跳过（不产降级安装）', () => {
    const out = resolveCompliantVersion(baseInput({ runningVersion: '1.66.27' }))
    assert.equal(out.kind, 'wait-until')
  })

  it('候选三锁：stable 通道跳过表里的预发布条目', () => {
    const out = resolveCompliantVersion(
      baseInput({
        timeTable: { '1.66.28': PUBLISHED, '1.66.28-beta.1': PUBLISHED - 5 * DAY },
      }),
    )
    assert.equal(out.kind, 'wait-until')
  })

  it('边界取等：age 恰好等于 window 即合规', () => {
    const out = resolveCompliantVersion(baseInput({ nowMs: UNLOCK }))
    assert.equal(out.kind, 'ok-now')
  })

  it('坏表项忽略不连坐（null/负数/字符串/NaN）', () => {
    const out = resolveCompliantVersion(
      baseInput({
        timeTable: {
          '1.66.28': PUBLISHED,
          '1.66.27': PUBLISHED - 2 * DAY,
          bad: null,
          neg: -5,
          str: '昨天',
          nan: NaN,
        },
      }),
    )
    assert.equal(out.kind, 'downgrade-available')
  })

  it('registry 表优先、报文时间为 fallback：表缺最新版时用报文时间照样决议', () => {
    const out = resolveCompliantVersion(baseInput({ timeTable: { '1.66.27': PUBLISHED - 2 * DAY } }))
    assert.equal(out.kind, 'downgrade-available')
    assert.equal(out.targetUnlockAtMs, UNLOCK)
  })

  it('windowSource 原样回传（derived/unknown 照样决议，精确与约是呈现层的事）', () => {
    const out = resolveCompliantVersion(baseInput({ windowSource: 'unknown' }))
    assert.equal(out.kind, 'downgrade-available')
    assert.equal(out.windowSource, 'unknown')
  })

  it('输入只读：不改调用方的时间表对象', () => {
    const table = { '1.66.28': PUBLISHED }
    const snap = JSON.stringify(table)
    resolveCompliantVersion(baseInput({ timeTable: table }))
    assert.equal(JSON.stringify(table), snap)
  })
})
