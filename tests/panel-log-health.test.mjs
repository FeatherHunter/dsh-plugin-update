/**
 * tests/panel-log-health.test.mjs —— #212 日志健康：面板日志区那一行。
 *
 * 只测外部行为：调 renderUpdatePanelHTML 看 HTML、走真挂载链（mountUpdatePanel + 假传输）看回包里的
 * logHealth 有没有落到面板上。断言
 * 1. 老宿主没这个键（或不传 / null）时输出逐字不变；
 * 2. 有读数才多一行，且那一行就是 panel-copy 的单一措辞源（面板不自己拼字）；
 * 3. 日志指引关掉（showLogHint:false）时这一行跟着藏；
 * 4. 认不出的形状说「无法识别」，不假装正常；自由文本经 escapeHtml，不注入。
 * 不测内部实现、不测样式像素。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel, renderUpdatePanelHTML } from '../dist/panel.js'
import { logHealthText } from '../dist/panel-copy.js'

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installed: true,
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

/** 假容器：只要 innerHTML（按钮走 controller.act）。 */
function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function renderInput(overrides = {}) {
  return {
    snapshot: baseSnapshot(),
    manual: 'cmd',
    queue: baseQueue(),
    skippedLatest: false,
    lastError: 'network',
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
    mode: 'embedded',
    ...overrides,
  }
}

function selfHealth(overrides = {}) {
  return {
    sink: 'self',
    dirHash: 'deadbeef',
    switchEnabled: true,
    droppedSinceStart: 0,
    lastEventAt: 1790000000000,
    contract: 'ok',
    external: null,
    reason: null,
    ...overrides,
  }
}

/** 假传输：按电话名回固定剧本（status 里带不带 logHealth 由参数决定），并记下调用。 */
function fakeCall(logHealth) {
  const log = []
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.updateStatus')) {
      const reply = { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() }
      if (logHealth !== undefined) reply.logHealth = logHealth
      return reply
    }
    if (name.endsWith('.updateCheck')) {
      return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 999 }, queue: baseQueue() }
    }
    if (name.endsWith('.updateInstall')) return { ok: true, snapshot: baseSnapshot({ job: null }), manual: null }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

// ---------- 老宿主：零变化 ----------

test('#212 没给读数时面板逐字不变：不传 / undefined / null 三种输入同一串，且不出现日志健康句', () => {
  const input = renderInput()
  const base = renderUpdatePanelHTML(input)
  // 「落点=」是日志健康行独有的标记（既有日志路牌说的是「请查看日志：…」，不含它）。
  assert.ok(!base.includes('落点='), '没读数就不该多出日志健康行')
  assert.ok(base.includes('npx dsh-log'), '通用日志路牌照旧（#123 那一行不受影响）')
  assert.equal(renderUpdatePanelHTML({ ...input, logHealth: undefined }), base, 'undefined = 老宿主，输出必须一字不差')
  assert.equal(renderUpdatePanelHTML({ ...input, logHealth: null }), base, 'null = 没读数，输出必须一字不差')
  assert.ok(renderUpdatePanelHTML({ ...input, logHealth: { sink: 'nope' } }).includes('无法识别'), '认不出的形状也要有话说（另一测详断）')
})

// ---------- 有读数：一行，且来自单一措辞源 ----------

test('#212 self 读数：面板多一行，内容就是 logHealthText 的同一句（面板不自己拼字）', () => {
  const health = selfHealth()
  const html = renderUpdatePanelHTML({ ...renderInput(), logHealth: health })
  const sentence = logHealthText(health)
  assert.ok(sentence, '措辞源必须给句子')
  assert.ok(html.includes(sentence), '面板那一行必须逐字等于单一措辞源\n' + sentence)
  assert.ok(html.includes('落点=self') && html.includes('目录指纹=deadbeef'), html)
  assert.ok(html.includes('事件契约=正常'), '契约状态要看得见')
})

test('#212 external 未放行/未验证、off、pending 在面板上都说人话', () => {
  const cases = [
    [{ ...selfHealth(), sink: 'external', external: 'open', dirHash: null, switchEnabled: null }, '对方引擎确认放行本包事件'],
    [{ ...selfHealth(), sink: 'external', external: 'closed', dirHash: null, switchEnabled: null }, '对方引擎未放行本包事件'],
    [{ ...selfHealth(), sink: 'external', external: 'unknown', dirHash: null, switchEnabled: null }, '未验证'],
    [{ ...selfHealth(), sink: 'off', reason: 'no-dsh-log', dirHash: null, switchEnabled: null }, '本包不会再往日志目录写行'],
    [{ ...selfHealth(), sink: 'off', reason: 'lease-conflict', dirHash: null, switchEnabled: null }, '同目录写者冲突'],
    [{ ...selfHealth(), sink: 'pending', switchEnabled: null }, '接线中，稍后重查'],
  ]
  for (const [health, word] of cases) {
    const html = renderUpdatePanelHTML({ ...renderInput(), logHealth: health })
    assert.ok(html.includes(word), '面板上要说清「' + word + '」\n' + html.slice(0, 400))
    assert.ok(html.includes(logHealthText(health)), '每一句都来自措辞源')
  }
})

test('#212 日志指引关掉时这一行跟着藏；开了才出现', () => {
  const withHealth = renderUpdatePanelHTML({ ...renderInput(), logHealth: selfHealth() })
  assert.ok(withHealth.includes('落点=self'), '缺省是开的')
  const hidden = renderUpdatePanelHTML({ ...renderInput(), logHealth: selfHealth(), showLogHint: false })
  assert.ok(!hidden.includes('落点='), 'showLogHint:false 必须把日志健康行一并藏掉')
  assert.ok(!hidden.includes('deadbeef'), '藏就藏干净，不留指纹')
  const neutral = renderUpdatePanelHTML({ ...renderInput({ lastError: null }), logHealth: selfHealth() })
  assert.ok(neutral.includes('落点=self'), '没失败（中性态）也照样报日志健康')
})

test('#212 认不出的形状说「无法识别」，不假装正常；读数里的自由文本经 escapeHtml 不注入', () => {
  const weird = renderUpdatePanelHTML({ ...renderInput(), logHealth: { sink: 'weird', dirHash: '<img src=x onerror=alert(1)>' } })
  assert.ok(weird.includes('无法识别'), '认不出就说认不出')
  assert.ok(!weird.includes('正常'), '认不出时不许显示「正常」')
  const evil = renderUpdatePanelHTML({ ...renderInput(), logHealth: selfHealth({ dirHash: '<img src=x onerror=alert(1)>' }) })
  assert.ok(!evil.includes('<img src=x'), '读数里的自由文本必须转义')
  assert.ok(evil.includes('&lt;img'), evil.slice(0, 400))
})

test('#212 面板双语：en 读数是英文且不混汉字，zh 缺省零回归', () => {
  const health = selfHealth()
  const zh = renderUpdatePanelHTML({ ...renderInput(), logHealth: health })
  const zhExplicit = renderUpdatePanelHTML({ ...renderInput(), logHealth: health }, 'zh')
  assert.equal(zhExplicit, zh, '缺省 zh 与显式 zh 一字不差')
  const en = renderUpdatePanelHTML({ ...renderInput(), logHealth: health }, 'en')
  const sentence = logHealthText(health, 'en')
  assert.ok(en.includes(sentence), 'en 面板用 en 那一句')
  assert.ok(!/[\u4e00-\u9fff]/.test(sentence), 'en 句不混汉字：' + sentence)
})

// ---------- 真挂载链：回包 → 面板 ----------

test('#212 挂载链：成功回包带 logHealth 就落到面板上（那一跳不只活在渲染函数里）', async () => {
  const health = selfHealth()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call: fakeCall(health).call, pollMs: 60000 })
  await panel.refresh()
  assert.ok(box.innerHTML.includes(logHealthText(health)), '回包里的读数要一路走到面板\n' + box.innerHTML.slice(0, 400))
  assert.ok(box.innerHTML.includes('目录指纹=deadbeef'))
  panel.unmount()
})

test('#212 挂载链：老宿主回包没有这个键 → 面板不多话，通用路牌照旧', async () => {
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call: fakeCall(undefined).call, pollMs: 60000 })
  await panel.refresh()
  assert.ok(!box.innerHTML.includes('落点='), '老宿主没有 logHealth 键，面板一个字都不多')
  assert.ok(box.innerHTML.includes('npx dsh-log'), '通用日志路牌照旧')
  panel.unmount()
})
