/**
 * tests/panel-failure-latch.test.mjs —— #58 安装失败常驻与复制诊断锁定。
 *
 * 只测外部行为：调公开入口（mount / act / refresh），看横幅、看复制诊断文本，
 * 不刺探内部闭包变量。
 *
 * 背景：安装失败瞬间有失败态，随后一次成功的状态轮询即洗回“可装”绿页，
 * 且复制诊断回退到 check-failed 兜底（与本次安装无关）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel } from '../dist/panel.js'

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '0.4.1',
    installedVersion: '0.4.1',
    latestVersion: '0.4.2',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function failedInstallJob(message = 'install-failed: 宿主执行失败') {
  return { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message, requestId: 'req-install-1' }
}

function scriptedCall(script) {
  const texts = []
  const log = []
  const call = async (name, args) => {
    log.push(name)
    if (name.endsWith('.updateStatus')) return script.status()
    if (name.endsWith('.updateCheck')) return script.check()
    if (name.endsWith('.updateInstall')) return script.install()
    throw new Error('unknown-phone:' + name)
  }
  return { call, log, texts }
}

function mountFor(pluginId, script, extra = {}) {
  const { call, log, texts } = scriptedCall(script)
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, {
    pluginId,
    call,
    pollMs: 60000,
    copyText: async (t) => texts.push(t),
    autoChangelog: false,
    ...extra,
  })
  return { panel, box, log, texts }
}

async function settled(ms = 20) {
  await new Promise((r) => setTimeout(r, ms))
}

const okStatus = () => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() })
const okCheck = () => ({
  ok: true,
  snapshot: baseSnapshot(),
  manual: null,
  receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 9999999999999 },
  queue: baseQueue(),
})

// ---------- 1. 安装失败常驻：只读轮询成功不洗掉 ----------

test('#58 安装失败常驻：失败横幅活过一次成功的状态轮询', async () => {
  const state = { installReply: { ok: false, error: 'install-failed', errorKind: 'install-failed' } }
  const { panel, box } = mountFor('latch-1', {
    status: okStatus,
    check: okCheck,
    install: () => state.installReply,
  })
  await settled()
  await settled()
  await panel.act('install')
  await settled()
  assert.match(box.innerHTML, /更新失败/, '安装失败后应有失败横幅')
  await panel.refresh()
  await settled()
  assert.match(box.innerHTML, /更新失败/, '一次成功的状态轮询后失败横幅仍在')
  assert.doesNotMatch(box.innerHTML, /有新版.*可装/, '不应回到可装绿页')
  panel.unmount()
})

// ---------- 2. 复制诊断锁定致命安装回包 ----------

test('#58 复制诊断锁定：失败后复制的是安装失败码而非 check-failed', async () => {
  const { panel, texts } = mountFor('latch-2', {
    status: okStatus,
    check: okCheck,
    install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
  })
  await settled()
  await settled()
  await panel.act('install')
  await settled()
  await panel.refresh()
  await settled()
  await panel.act('copy-diag')
  await settled()
  const last = texts.at(-1) ?? ''
  assert.match(last, /install-failed/, '复制诊断应为安装失败码，实际=' + JSON.stringify(last))
  assert.doesNotMatch(last, /check-failed/, '不应回退到 check-failed 兜底')
  panel.unmount()
})

// ---------- 3. 用户主动重查成功解除查失败，但不解除装失败 ----------

test('#58 用户重查成功：解除查失败锁存，装失败锁存保留', async () => {
  const state = { checkFail: true }
  const { panel, box } = mountFor('latch-3', {
    status: okStatus,
    check: () => (state.checkFail ? { ok: false, error: 'check-failed', errorKind: 'check-failed' } : okCheck()),
    install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
  })
  await settled()
  await settled()
  // mount 自动查失败一次（系统意图）：失败应已锁存
  assert.match(box.innerHTML, /更新失败/, '查失败后应有失败横幅')
  // 用户再查一次且成功：查失败解除
  state.checkFail = false
  await panel.act('check')
  await settled()
  assert.match(box.innerHTML, /有新版.*可装/, '用户重查成功后查失败应解除')
  // 装失败一次：锁存
  await panel.act('install')
  await settled()
  assert.match(box.innerHTML, /更新失败/, '装失败后应有失败横幅')
  // 用户再查成功：装失败不解除
  await panel.act('check')
  await settled()
  assert.match(box.innerHTML, /更新失败/, '用户重查成功不解除装失败锁存')
  panel.unmount()
})

// ---------- 4. 用户重装成功（新一轮开始）解除 ----------

test('#58 新一轮安装开始：失败锁存解除并显示进度', async () => {
  const state = { installFail: true }
  const { panel, box } = mountFor('latch-4', {
    status: okStatus,
    check: okCheck,
    install: () =>
      state.installFail
        ? { ok: false, error: 'install-failed', errorKind: 'install-failed' }
        : { ok: true, snapshot: baseSnapshot({ job: { id: 'job-2', state: 'installing', targetVersion: '0.4.2', message: null, requestId: 'req-2' } }), manual: null },
  })
  await settled()
  await settled()
  await panel.act('install')
  await settled()
  assert.match(box.innerHTML, /更新失败/, '装失败后应有失败横幅')
  state.installFail = false
  await panel.act('install')
  await settled()
  assert.match(box.innerHTML, /正在安装/, '新一轮安装开始后应显示进度而非旧失败')
  panel.unmount()
})

// ---------- 5. 查失败同样不被轮询洗掉 ----------

test('#58 查失败常驻：成功的状态轮询不清除查失败', async () => {
  const { panel, box, texts } = mountFor('latch-5', {
    status: okStatus,
    check: () => ({ ok: false, error: 'check-failed', errorKind: 'check-failed' }),
    install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
  })
  await settled()
  await settled()
  assert.match(box.innerHTML, /更新失败/, '查失败后应有失败横幅')
  await panel.refresh()
  await settled()
  assert.match(box.innerHTML, /更新失败/, '状态轮询成功后查失败仍在')
  await panel.act('copy-diag')
  await settled()
  assert.match(texts.at(-1) ?? '', /check-failed/, '复制诊断应为查失败码')
  panel.unmount()
})

// ---------- 6. 忙不进锁存 ----------

test('#58 忙是瞬态：update-busy 不锁存，轮询成功即回可装', async () => {
  const { panel, box } = mountFor('latch-6', {
    status: okStatus,
    check: okCheck,
    install: () => ({ ok: false, error: 'update-busy', errorKind: 'update-busy' }),
  })
  await settled()
  await settled()
  await panel.act('install')
  await settled()
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /更新失败/, '忙不应留下失败横幅')
  assert.match(box.innerHTML, /有新版.*可装/, '忙过后应回到可装页')
  panel.unmount()
})

// ---------- 7. 后台失败经状态到达并单调置入 ----------

test('#58 后台失败：状态快照 job failed 置入锁存，且不被后续空轮询清除', async () => {
  const state = { bgFailed: false }
  const { panel, box, texts } = mountFor('latch-7', {
    status: () =>
      state.bgFailed
        ? { ok: true, snapshot: baseSnapshot({ job: failedInstallJob() }), manual: null, receipt: null, queue: baseQueue() }
        : okStatus(),
    check: okCheck,
    install: () => ({ ok: true, snapshot: baseSnapshot({ job: { id: 'job-1', state: 'installing', targetVersion: '0.4.2', message: null, requestId: 'req-install-1' } }), manual: null }),
  })
  await settled()
  await settled()
  await panel.act('install')
  await settled()
  assert.match(box.innerHTML, /正在安装/, '安装应先进入进度态')
  state.bgFailed = true
  await panel.refresh()
  await settled()
  assert.match(box.innerHTML, /更新失败/, '后台失败到达后应显示失败横幅')
  state.bgFailed = false
  await panel.refresh()
  await settled()
  assert.match(box.innerHTML, /更新失败/, '后续空轮询不应清除后台失败')
  await panel.act('copy-diag')
  await settled()
  assert.match(texts.at(-1) ?? '', /install-failed/, '复制诊断应为后台安装失败码')
  panel.unmount()
})

// ---------- 8. 版本变化解除 ----------

test('#58 版本变化解除：磁盘版本追上后失败锁存清除', async () => {
  const state = { landed: false }
  const { panel, box } = mountFor('latch-8', {
    status: () =>
      state.landed
        ? { ok: true, snapshot: baseSnapshot({ installedVersion: '0.4.2', job: null }), manual: null, receipt: null, queue: baseQueue() }
        : okStatus(),
    check: okCheck,
    install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
  })
  await settled()
  await settled()
  await panel.act('install')
  await settled()
  assert.match(box.innerHTML, /更新失败/, '装失败后应有失败横幅')
  state.landed = true
  await panel.refresh()
  await settled()
  assert.doesNotMatch(box.innerHTML, /更新失败/, '版本变化后失败应解除')
  panel.unmount()
})

// ---------- 9. 显式确认解除 ----------

test('#58 显式确认：用户确认后回到可装页', async () => {
  const { panel, box } = mountFor('latch-9', {
    status: okStatus,
    check: okCheck,
    install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
  })
  await settled()
  await settled()
  await panel.act('install')
  await settled()
  assert.match(box.innerHTML, /更新失败/, '装失败后应有失败横幅')
  await panel.act('dismiss-failure')
  await settled()
  assert.doesNotMatch(box.innerHTML, /更新失败/, '确认后失败横幅应消失')
  assert.match(box.innerHTML, /有新版.*可装/, '确认后回到可装页')
  panel.unmount()
})

// ---------- 10. 跨重挂存活且 mount 自动查不解除装失败 ----------

test('#58 跨重挂存活：重开面板后装失败仍在，自动查不清除它', async () => {
  const shared = {
    status: okStatus,
    check: okCheck,
    install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
  }
  const first = mountFor('latch-10', shared)
  await settled()
  await settled()
  await first.panel.act('install')
  await settled()
  assert.match(first.box.innerHTML, /更新失败/, '首次挂载装失败后应有失败横幅')
  first.panel.unmount()
  const second = mountFor('latch-10', shared)
  await settled()
  await settled()
  assert.match(second.box.innerHTML, /更新失败/, '重开面板后装失败仍应存在（自动查不清除）')
  second.panel.unmount()
});

// ---------- 11. 健康可装页复制诚实：不伪造失败码 ----------

test('#58 健康可装页复制：无失败即报状态快照，不编 check-failed', async () => {
  const { panel, texts } = mountFor('latch-11', {
    status: okStatus,
    check: okCheck,
    install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
  })
  await settled()
  await settled()
  await panel.act('copy-diag')
  await settled()
  const last = texts.at(-1) ?? ''
  assert.match(last, /当前无失败/, '健康态复制应声明无失败')
  assert.match(last, /远端.*0\.4\.2/, '应带远端版本，实际=' + JSON.stringify(last))
  assert.doesNotMatch(last, /check-failed/, '不得伪造查失败码')
  assert.doesNotMatch(last, /install-failed/, '不得伪造安装失败码')
  panel.unmount()
});

// ---------- 12. 健康已最新页复制诚实 ----------

test('#58 健康已最新页复制：同样诚实无码', async () => {
  const upToDate = () => ({ ok: true, snapshot: baseSnapshot({ latestVersion: '0.4.1', canInstall: false }), manual: null, receipt: null, queue: baseQueue() })
  const { panel, texts } = mountFor('latch-12', { status: upToDate, check: upToDate, install: () => ({ ok: false, error: 'x', errorKind: 'x' }) })
  await settled()
  await settled()
  await panel.act('copy-diag')
  await settled()
  const last = texts.at(-1) ?? ''
  assert.match(last, /当前无失败/, '应声明无失败')
  assert.match(last, /已是最新/, '应报已是最新')
  assert.doesNotMatch(last, /check-failed/, '不得伪造失败码')
  panel.unmount()
});
