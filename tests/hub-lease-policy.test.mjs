/**
 * tests/hub-lease-policy.test.mjs —— 更新中枢 T1：驾驶位租约是纯判决（issue #247 的一部分）。
 *
 * 黑盒视角回答一个问题：盘上有一份租约，我现在到底算不算驾驶位？四种判决：
 * 上任（acquire）、续任（renew）、接管（takeover）、让位（wait）。
 *
 * 这里守的是「防双驾驶」：投递判决永远拿不到更小的 generation；旧代次写回必须被拒；
 * 失联（心跳过期）或进程已死才接管；心跳新鲜就等——宁可不动，也不抢一次错的安装。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HUB_LEASE_HEARTBEAT_MS,
  HUB_LEASE_STALE_MS,
  createHubLease,
  decideHubLease,
  isHubDriverId,
  isHubLeaseOwner,
  normalizeHubLease,
  shouldHeartbeatHubLease,
} from '../dist/core/hub/lease-policy.js'

const DRIVER = 'dsh-hub:4242:abc'

function leaseOf(overrides = {}) {
  return createHubLease({ driverId: DRIVER, pluginId: 'life-pack', pid: 4242, now: 10_000, ...overrides })
}

describe('#247 中枢驾驶位租约（纯判决）', () => {
  it('盘上没有租约 → 上任，第一代', () => {
    assert.deepEqual(decideHubLease({ current: null, driverId: DRIVER, now: 1_000 }), { kind: 'acquire', generation: 1 })
    assert.deepEqual(decideHubLease({ current: {}, driverId: DRIVER, now: 1_000 }), { kind: 'acquire', generation: 1 })
  })

  it('租约还是我的 → 续任，代次不变', () => {
    assert.deepEqual(decideHubLease({ current: leaseOf(), driverId: DRIVER, now: 10_100 }), { kind: 'renew', generation: 1 })
  })

  it('别人活着且心跳新鲜 → 让位', () => {
    assert.deepEqual(
      decideHubLease({ current: leaseOf(), driverId: 'dsh-hub:9999:zzz', now: 10_000 + HUB_LEASE_STALE_MS - 1, processAlive: null }),
      { kind: 'wait' },
    )
  })

  it('心跳过期且进程状态未知 → 接管，代次 +1', () => {
    assert.deepEqual(
      decideHubLease({ current: leaseOf(), driverId: 'dsh-hub:9999:zzz', now: 10_000 + HUB_LEASE_STALE_MS }),
      { kind: 'takeover', generation: 2 },
    )
  })

  it('对方进程已死 → 立即接管（哪怕心跳新鲜）', () => {
    assert.deepEqual(
      decideHubLease({ current: leaseOf(), driverId: 'dsh-hub:9999:zzz', now: 10_100, processAlive: false }),
      { kind: 'takeover', generation: 2 },
    )
  })

  it('对方进程活着但心跳未满陈旧窗口 → 让位', () => {
    assert.deepEqual(
      decideHubLease({ current: leaseOf(), driverId: 'dsh-hub:9999:zzz', now: 10_000 + HUB_LEASE_STALE_MS - 1, processAlive: true }),
      { kind: 'wait' },
    )
  })

  it('对方进程活着但心跳已满陈旧窗口 → 接管（假死，不等它「也许还活着」）', () => {
    assert.deepEqual(
      decideHubLease({ current: leaseOf(), driverId: 'dsh-hub:9999:zzz', now: 10_000 + HUB_LEASE_STALE_MS, processAlive: true }),
      { kind: 'takeover', generation: 2 },
    )
  })

  it('旧代次写回被判非属主（防双驾驶）', () => {
    const lease = leaseOf()
    assert.equal(isHubLeaseOwner(lease, DRIVER), true)
    assert.equal(isHubLeaseOwner(lease, DRIVER, lease.generation), true)
    assert.equal(isHubLeaseOwner(lease, DRIVER, lease.generation + 1), false)
    assert.equal(isHubLeaseOwner(lease, 'dsh-hub:1:x'), false)
    assert.equal(isHubLeaseOwner(null, DRIVER), false)
  })

  it('该心跳了吗：到点才写盘', () => {
    const lease = leaseOf()
    assert.equal(shouldHeartbeatHubLease(lease, 10_000 + HUB_LEASE_HEARTBEAT_MS - 1), false)
    assert.equal(shouldHeartbeatHubLease(lease, 10_000 + HUB_LEASE_HEARTBEAT_MS), true)
    assert.equal(shouldHeartbeatHubLease(null, 10_000 + HUB_LEASE_HEARTBEAT_MS), false)
    assert.equal(shouldHeartbeatHubLease(lease, 'x'), false)
  })

  it('坏租约当没有租约；坏输入不抛', () => {
    assert.equal(normalizeHubLease({}), null)
    assert.equal(normalizeHubLease({ version: 2 }), null)
    assert.equal(normalizeHubLease('x'), null)
    assert.deepEqual(decideHubLease({ current: 'x', driverId: DRIVER, now: 5 }), { kind: 'acquire', generation: 1 })
    assert.deepEqual(decideHubLease(null), { kind: 'wait' })
    assert.deepEqual(decideHubLease({ current: leaseOf(), driverId: '', now: 1 }), { kind: 'wait' })
  })

  it('造租约时就地归一坏值（上任前不崩）', () => {
    const lease = createHubLease({ driverId: '', pluginId: '', pid: -1, now: -5 })
    assert.equal(lease.driverId, 'unknown-driver')
    assert.equal(lease.pluginId, 'unknown-plugin')
    assert.equal(lease.pid, 0)
    assert.equal(lease.startedAt, 0)
    assert.equal(lease.heartbeatAt, 0)
    assert.equal(lease.generation, 1)
    assert.equal(lease.version, 1)
    assert.equal(isHubDriverId(lease.driverId), true)
  })
})
