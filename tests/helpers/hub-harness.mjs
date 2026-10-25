/**
 * tests/helpers/hub-harness.mjs —— 中枢宿主级测试的共用件（#253 / #254 抽出）。
 *
 * 纪律与 batch-log-harness 相同：只依赖 Node 内置与 `dist/` 公共入口，不 import `src/`；
 * 新写中枢测试先看这里，不要再各自抄一套假时钟 / hubDeps。
 *
 * fakeClock：定时器归测试手动推进（退避重试要可控、断言「起没起/停没停」要确定）；
 *   flush 里让出一拍真实时间，等磁盘/线程池回调落定，避免「泵刚收手」与「断言已到」赛跑。
 * makeHubDeps：中枢宿主测试的建实例参数；每个实例一个独立 driverId，两个「宿主」同进程共存时
 *   旧泵的释放不能删掉新驾驶位。
 * waitForPhase：轮询电话直到某一行到目标相位（中枢自己推进的场景用，不 sleep 等）。
 * trackUnhandledRejections：收后台未处理 rejection（DSH 会据此退出进程，测试要断言一个都没有）。
 */
import { phaseOf } from './batch-log-harness.mjs'

export function fakeClock(start = 1_000_000) {
  let current = start
  let seq = 0
  const timers = new Map()
  const timersPort = {
    setTimeout(fn, ms) {
      seq += 1
      const id = seq
      timers.set(id, { fn, at: current + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  }
  async function flush() {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
    // setImmediate 轮转不保证等得到磁盘/线程池回调：再让出一拍真实时间。
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  async function advance(ms) {
    const target = current + ms
    for (let round = 0; round < 50; round += 1) {
      await flush()
      current = target
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)
      if (due.length === 0) return
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.fn()
      }
    }
  }
  return { now: () => current, timers: timersPort, advance, flush, pending: () => timers.size }
}

let driverSeq = 0

/**
 * 中枢宿主测试的建实例参数：唯一 driverId（每实例递增）、假时钟、假传输。
 * extra 覆盖缺省口子（如注入会抛异常的 io 验证异常边界）。
 */
export function makeHubDeps(scope, clock, transport, extra = {}) {
  driverSeq += 1
  return {
    scope,
    transport,
    timers: clock.timers,
    now: clock.now,
    randomId: () => 'hub-test-slot-' + driverSeq,
    hubRetryMs: 5,
    ...extra,
  }
}

/** 轮询电话直到某一行到目标相位（中枢自己推进的场景用）。 */
export async function waitForPhase(clock, host, phone, key, phase) {
  for (let i = 0; i < 200; i += 1) {
    await clock.flush()
    await clock.advance(10)
    const reply = await host.handlers[phone]({})
    if (phaseOf(reply?.session, key) === phase) return reply
  }
  throw new Error('等不到相位 ' + phase + '（' + key + '）')
}

/** 收未处理 rejection：DSH 会把它们升级成进程退出，所以测试里必须断言「一个都没有」。 */
export function trackUnhandledRejections() {
  const seen = []
  const onUnhandled = (reason) => seen.push(reason)
  process.on('unhandledRejection', onUnhandled)
  return {
    seen,
    async settle() {
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    stop() {
      process.off('unhandledRejection', onUnhandled)
    },
  }
}
