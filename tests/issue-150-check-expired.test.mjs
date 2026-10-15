/**
 * tests/issue-150-check-expired.test.mjs —— #150：过期凭证必须自动续，未安装无收据不许伪造过期码。
 *
 * 只测外部行为：假传输挂载安装按钮，点安装，看电话次数与锁存码。
 * 红测试（修前必红）：
 * 1. 安装被拒 check-expired → 自动重查一次 + 新凭证重装一次（updateCheck 2 次、updateInstall 2 次，且第二次带新 checkId）；
 * 2. 查回 ok:true 但无收据（含阻拦原因）→ 不许锁存 check-expired；
 * 3. 旧失败锁存 + 新查 ok:true 无收据（空闲）→ 旧锁存清掉，快照说话（本轮派生的 job 失败锁存保留）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mountInstallButton } from '../dist/install-button.js'

function absentInstallable(over = {}) {
  return {
    runningVersion: '0.0.0',
    installed: false,
    installedVersion: null,
    latestVersion: '0.3.58',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...over,
  }
}

function baseQueue(over = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...over }
}

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== listener))
    },
    click(attrs) {
      const matches = (sel) => {
        const m = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel)
        if (!m) return false
        if (!Object.prototype.hasOwnProperty.call(attrs, m[1])) return false
        return m[2] === undefined || attrs[m[1]] === m[2]
      }
      const ev = {
        target: {
          closest(sel) {
            return matches(sel) ? { getAttribute: (k) => (k in attrs ? attrs[k] : null) } : null
          },
        },
      }
      for (const fn of [...(listeners.get('click') ?? [])]) fn(ev)
    },
  }
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

let timerFns = []
let origSet = null
let origClear = null
beforeEach(() => {
  timerFns = []
  origSet = globalThis.setInterval
  origClear = globalThis.clearInterval
  globalThis.setInterval = (fn) => {
    timerFns.push(fn)
    return timerFns.length
  }
  globalThis.clearInterval = () => {}
})
afterEach(() => {
  globalThis.setInterval = origSet
  globalThis.clearInterval = origClear
})

function callsOf(log, suffix) {
  return log.filter((e) => e.name.endsWith(suffix))
}

describe('issue-150：过期自动续一次', () => {
  it('安装被拒 check-expired → 重查 + 新凭证重装，终态不再失败', async () => {
    const log = []
    let checkCount = 0
    let installCount = 0
    const call = async (name, args) => {
      log.push({ name, args })
      if (name.endsWith('.updateStatus')) {
        return { ok: true, snapshot: absentInstallable(), manual: null, receipt: null, queue: baseQueue() }
      }
      if (name.endsWith('.updateCheck')) {
        checkCount += 1
        return {
          ok: true,
          snapshot: absentInstallable(),
          manual: null,
          receipt: { checkId: `check-${checkCount}`, checkedAt: checkCount, expiresAt: 99999 },
          queue: baseQueue(),
        }
      }
      if (name.endsWith('.updateInstall')) {
        installCount += 1
        if (installCount === 1) {
          return { ok: false, error: 'check-expired', errorKind: 'check-expired', queue: baseQueue() }
        }
        return {
          ok: true,
          snapshot: absentInstallable({
            job: { id: 'j1', state: 'installing', targetVersion: '0.3.58', message: null, requestId: args.requestId ?? null },
          }),
          manual: null,
          queue: baseQueue(),
        }
      }
      if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
      throw new Error('unknown-phone:' + name)
    }
    const container = fakeContainer()
    const btn = mountInstallButton(container, {
      pluginId: 'dsh-life-pack-bill',
      prefix: 'ilife-bill',
      call,
      autoCheck: 'never',
      clientLog: null,
    })
    await btn.refresh()
    await flush()
    log.length = 0
    checkCount = 0
    installCount = 0
    container.click({ 'data-action': 'install' })
    await flush(20)
    assert.equal(callsOf(log, '.updateCheck').length, 2, '应自动重查一次拿新凭证')
    assert.equal(callsOf(log, '.updateInstall').length, 2, '应用新凭证重装一次')
    const second = callsOf(log, '.updateInstall')[1]
    assert.equal(second.args.checkId, 'check-2', '重装必须带新收据编号')
    assert.equal(btn.state().failedCode, null, '重装已提交后不应再锁存失败')
    btn.unmount()
  })

  it('查回无收据（含阻拦原因）→ 不许伪造 check-expired', async () => {
    const log = []
    const blocked = absentInstallable({ canInstall: false, blockedReason: 'channel-mismatch' })
    const call = async (name) => {
      log.push({ name })
      if (name.endsWith('.updateStatus')) {
        // 点击时快照可装（按钮可见），装中重查才发现真实阻拦。
        return { ok: true, snapshot: absentInstallable(), manual: null, receipt: null, queue: baseQueue() }
      }
      if (name.endsWith('.updateCheck')) {
        return { ok: true, snapshot: blocked, manual: null, receipt: null, queue: baseQueue() }
      }
      if (name.endsWith('.updateInstall')) {
        throw new Error('must-not-install-without-receipt')
      }
      if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
      throw new Error('unknown-phone:' + name)
    }
    const container = fakeContainer()
    const btn = mountInstallButton(container, {
      pluginId: 'dsh-life-pack-bill',
      prefix: 'ilife-bill',
      call,
      autoCheck: 'never',
      clientLog: null,
    })
    await btn.refresh()
    await flush()
    container.click({ 'data-action': 'install' })
    await flush()
    const st = btn.state()
    assert.notEqual(st.failedCode, 'check-expired', '无收据的真实原因是阻拦，不许报过期')
    assert.equal(callsOf(log, '.updateInstall').length, 0, '无收据时不许提交安装')
    btn.unmount()
  })

  it('旧装失败锁存 + 再次点击时旧凭证已过期 → 自愈续查，旧锁存清掉', async () => {
    const log = []
    let phase = 'fail'
    let checkCount = 0
    const idle = {
      runningVersion: '0.3.58',
      installed: true,
      installedVersion: '0.3.58',
      latestVersion: '0.3.58',
      canInstall: false,
      blockedReason: null,
      job: null,
    }
    const call = async (name, args) => {
      log.push({ name, args })
      if (name.endsWith('.updateStatus')) {
        return { ok: true, snapshot: absentInstallable(), manual: null, receipt: null, queue: baseQueue() }
      }
      if (name.endsWith('.updateCheck')) {
        checkCount += 1
        if (phase === 'fail') {
          return {
            ok: true,
            snapshot: absentInstallable(),
            manual: null,
            receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 99999 },
            queue: baseQueue(),
          }
        }
        return { ok: true, snapshot: idle, manual: null, receipt: null, queue: baseQueue() }
      }
      if (name.endsWith('.updateInstall')) {
        if (phase === 'fail') return { ok: false, error: 'install-failed', queue: baseQueue() }
        // 第二次点击沿用旧收据：宿主拒收过期凭证，按钮必须续查而不是复用。
        if (args.checkId === 'check-1') return { ok: false, error: 'check-expired', errorKind: 'check-expired' }
        throw new Error('must-not-install-without-fresh-receipt:' + args.checkId)
      }
      if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
      throw new Error('unknown-phone:' + name)
    }
    const container = fakeContainer()
    const btn = mountInstallButton(container, {
      pluginId: 'dsh-life-pack-bill',
      prefix: 'ilife-bill',
      call,
      autoCheck: 'never',
      clientLog: null,
    })
    await btn.refresh()
    await flush()
    container.click({ 'data-action': 'install' })
    await flush(20)
    assert.equal(btn.state().failedCode, 'install-failed', '先制造一次装失败锁存')
    phase = 'idle'
    log.length = 0
    container.click({ 'data-action': 'install' })
    await flush(20)
    assert.equal(callsOf(log, '.updateCheck').length, 1, '旧凭证被拒后必须重查，不许复用旧编号空转')
    assert.equal(callsOf(log, '.updateInstall').length, 1, '续查无收据，不许再提交安装')
    assert.equal(btn.state().failedCode, null, '新查结论是空闲，旧失败锁存必须清掉')
    btn.unmount()
  })

  it('本轮查派生的 job 失败锁存 → 不许被无收据分支洗掉', async () => {
    const log = []
    const jobFailed = absentInstallable({
      canInstall: false,
      job: { id: 'j9', state: 'failed', targetVersion: '0.3.58', message: 'install-failed: exit 1', requestId: 'req-9' },
    })
    const call = async (name) => {
      log.push({ name })
      if (name.endsWith('.updateStatus')) {
        return { ok: true, snapshot: absentInstallable(), manual: null, receipt: null, queue: baseQueue() }
      }
      if (name.endsWith('.updateCheck')) {
        return { ok: true, snapshot: jobFailed, manual: null, receipt: null, queue: baseQueue() }
      }
      if (name.endsWith('.updateInstall')) {
        throw new Error('must-not-install-without-receipt')
      }
      if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
      throw new Error('unknown-phone:' + name)
    }
    const container = fakeContainer()
    const btn = mountInstallButton(container, {
      pluginId: 'dsh-life-pack-bill',
      prefix: 'ilife-bill',
      call,
      autoCheck: 'never',
      clientLog: null,
    })
    await btn.refresh()
    await flush()
    container.click({ 'data-action': 'install' })
    await flush()
    assert.equal(btn.state().failedCode, 'install-failed', '本轮刚派生的 job 失败必须保留展示')
    assert.equal(callsOf(log, '.updateInstall').length, 0, '无收据时不许提交安装')
    btn.unmount()
  })
})
