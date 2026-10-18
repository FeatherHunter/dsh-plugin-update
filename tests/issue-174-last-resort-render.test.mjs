// tests/issue-174-last-resort-render.test.mjs —— #174：三处渲染点的最后手段高亮 + #177 命令可信度 + v1.3 交互。
// 覆盖：面板 / 批量 / 槽位；data-last-resort 只在 last-resort；carried-over fail-closed；A′ 形态与无 emoji 图标；
// 失败回包后的静默补读只一次；复制成功浮出气泡且按钮文案不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { mountUpdatePanel, renderUpdatePanelHTML } = await import('../dist/panel.js')
const { renderBatchPanelHTML } = await import('../dist/panel-batch.js')
const { installButtonViewModel, renderInstallButtonHTML } = await import('../dist/install-button.js')

const MANUAL = 'dsh plugin --profile web add --save-exact my-plugin@1.1.0 --registry=https://registry.npmjs.org/'
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u

const tick = () => new Promise((r) => setTimeout(r, 15))

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installed: true,
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: false,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function panelHTML(extra = {}) {
  return renderUpdatePanelHTML({
    snapshot: baseSnapshot(),
    manual: MANUAL,
    manualSource: 'frame',
    pluginId: 'p',
    mode: 'embedded',
    lastError: 'install-failed',
    errorKind: 'install-failed',
    failure: { requestId: 'r1', checkId: null, atMs: 1, source: 'install', volatile: false, targetVersion: '1.1.0' },
    ...extra,
  })
}

/** 只取 DOM 部分：样式串里也含类名，打卡片断言必须避开 `<style>`。 */
function bodyOf(html) {
  return html.replace(/^<style>[\s\S]*?<\/style>\s*/, '')
}

// ---------- 单插件面板 ----------

test('#174 面板：安装失败 + 当帧可信命令 + 无合规版 → A′ 最后手段条', () => {
  const html = panelHTML({ fallbackAvailable: false })
  const body = bodyOf(html)
  assert.ok(body.includes('data-last-resort="last-resort"'), '最后手段钩子要在')
  assert.ok(body.includes('class="dsh-upd-lastresort"'), '语义类只在最后手段出现')
  assert.ok(body.includes('最后手段'), '徽标文案')
  assert.ok(body.includes('自动恢复不可用'), '状态短语')
  assert.ok(body.includes('没有可用的自动数据路径'), '归因句')
  // A′ 形态：左红轨 + 手绘 SVG + 徽标 + 状态短语 + 归因句 + 紧凑主按钮同屏。
  assert.ok(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/.test(body), '手绘 SVG 且不进语义')
  assert.ok(!/<use\b/.test(body), '不引外部图标')
  assert.ok(!EMOJI.test(body), '禁止 emoji 图标')
  assert.ok(
    /<button[^>]*class="[^"]*primary[^"]*"[^>]*data-action="copy-manual"/.test(body),
    '紧凑主按钮用 copy-manual（button.primary）',
  )
  // 失败块第一行：条在横幅之前。
  assert.ok(body.indexOf('dsh-upd-lastresort') >= 0 && body.indexOf('dsh-upd-lastresort') < body.indexOf('dsh-upd-banner'), '条在失败块第一行')
  // 05 章命令仍在，且标题旁带小徽标（徽标出现至少两处）。
  assert.ok((body.match(/最后手段/g) || []).length >= 2, '05 章 title 旁还有一枚徽标')
  assert.ok(body.includes(MANUAL), '命令块仍收在 05 章')
  assert.ok(body.indexOf(MANUAL) > body.indexOf('dsh-upd-lr-chap-badge'), '徽标在命令块之前')
})

test('#174 面板：CSS 令牌 / 过渡 / 无障碍降级', () => {
  const html = panelHTML()
  assert.ok(html.includes('.dsh-upd-lastresort'), '样式规则在')
  assert.ok(html.includes('border-left:4px solid var(--dsh-update-bad-text'), '左红轨用主题令牌')
  assert.ok(html.includes('box-shadow:0 0 0 2px var(--dsh-update-primary'), 'hover 用主色外环（不只 brightness）')
  assert.ok(html.includes('prefers-reduced-motion'), 'reduced-motion 降级')
  assert.ok(html.includes('forced-colors'), 'forced-colors 降级')
  assert.ok(!/transition:[^;}]*\b([2-9]\d{2}|\d{4,})ms/.test(html), '过渡不超过 150ms')
})

test('#174 面板：carried-over 命令 fail-closed（不展示 / 不复制 / 不高亮）', () => {
  const body = bodyOf(panelHTML({ manualSource: 'carried-over' }))
  assert.ok(!body.includes('data-last-resort'), '遗留命令不落钩子')
  assert.ok(!body.includes('class="dsh-upd-lastresort"'), '遗留命令不高亮')
  assert.ok(!body.includes(MANUAL), '不展示旧命令')
  assert.ok(!/data-action="copy-manual"/.test(body), '不给复制')
  assert.ok(body.includes('手工命令尚未按当帧读数确认'), '05 章给新键说明')
})

test('#174 面板：无命令的失败 → dead-end，不出现空高亮', () => {
  const body = bodyOf(panelHTML({ manual: null, manualSource: null }))
  assert.ok(!body.includes('data-last-resort'), '死路不落钩子')
  assert.ok(!body.includes('最后手段'), '死路不画徽标')
  assert.ok(body.includes('手工命令'), '05 章仍按 #92 说清原因')
})

test('#174 面板：有合规版救援 → salvageable，不高亮', () => {
  const body = bodyOf(panelHTML({ fallbackAvailable: true }))
  assert.ok(!body.includes('data-last-resort'), '有救援不落钩子')
  assert.ok(!body.includes('最后手段'), '有救援不画徽标')
})

test('#174 面板：查侧失败 → salvageable（重新查询就是救援）', () => {
  const body = bodyOf(
    panelHTML({ lastError: 'check-failed', errorKind: 'check-failed', failure: null, fallbackAvailable: false }),
  )
  assert.ok(!body.includes('data-last-resort'), '查侧失败不判无救')
})

// ---------- 批量面板 ----------

function failedRow(overrides = {}) {
  return {
    key: 'a',
    title: '甲插件',
    phase: 'failed',
    targetVersion: '1.1.0',
    restartRequired: false,
    error: 'install-failed',
    snapshot: baseSnapshot(),
    manual: MANUAL,
    manualSource: 'frame',
    queue: null,
    profileName: null,
    ...overrides,
  }
}

test('#174 批量：失败行带轻量标记，详情同 A′ 形态', () => {
  const html = renderBatchPanelHTML({ rows: [failedRow()], expandedKey: 'a' })
  assert.ok(html.includes('data-last-resort="last-resort"'), '行 / 详情要有钩子')
  assert.ok(html.includes('dsh-upd-lr-rowbadge'), '行状态区轻量标记')
  assert.ok(html.includes('最后手段'), '行标记文案')
  assert.ok(html.includes('class="dsh-upd-lastresort"'), '详情里 A′ 条')
  assert.ok(html.includes('data-act="row-copy-manual"'), '复制按钮沿用详情原有的')
})

test('#174 批量：carried-over 行 fail-closed（无标记 / 无复制 / 显示 stale）', () => {
  const html = renderBatchPanelHTML({ rows: [failedRow({ manualSource: 'carried-over' })], expandedKey: 'a' })
  assert.ok(!html.includes('data-last-resort'), '遗留行不落钩子')
  assert.ok(!bodyOf(html).includes('class="dsh-upd-lr-rowbadge"'), '遗留行不画标记（DOM 内）')
  assert.ok(!html.includes('data-act="row-copy-manual"'), '遗留行不给复制')
  assert.ok(html.includes('手工命令尚未按当帧读数确认'), '详情给 stale 说明')
})

test('#174 批量：混合行各自判定（只有有救且命令可信的那行亮）', () => {
  const rows = [
    failedRow({ key: 'a', title: '甲' }),
    failedRow({ key: 'b', title: '乙', manual: null, manualSource: null }),
    failedRow({ key: 'c', title: '丙', manual: 'x', manualSource: 'carried-over' }),
  ]
  const html = renderBatchPanelHTML({ rows })
  assert.equal((bodyOf(html).match(/class="dsh-upd-lr-rowbadge"/g) || []).length, 1, '只有一行亮')
})

// ---------- 槽位安装按钮 ----------

function slotHTML(opts = {}) {
  const view = installButtonViewModel({
    snapshot: baseSnapshot(),
    manual: opts.manual === undefined ? MANUAL : opts.manual,
    manualSource: opts.manualSource ?? 'frame',
    lastError: 'install-failed',
    errorKind: 'install-failed',
    lang: 'zh',
  })
  return renderInstallButtonHTML(view, {
    manual: opts.manual === undefined ? MANUAL : opts.manual,
    manualSource: opts.manualSource ?? 'frame',
    failureCode: 'install-failed',
    notice: null,
    theme: 'default',
    lang: 'zh',
  })
}

test('#174 槽位：失败折叠区同 A′ 形态，按钮在主位', () => {
  const html = slotHTML()
  assert.ok(html.includes('data-last-resort="last-resort"'), '槽位也要钩子')
  assert.ok(html.includes('class="dsh-upd-lastresort"'), '槽位 A′ 条')
  assert.ok(html.includes('最后手段') && html.includes('自动恢复不可用'), '徽标 + 状态短语')
  assert.ok(/<button[^>]*class="[^"]*primary[^"]*"[^>]*data-action="copy-manual"/.test(html), '主位 copy-manual 按钮')
  assert.ok(!EMOJI.test(html), '槽位也不许 emoji')
})

test('#174 槽位：carried-over 不给命令、不给复制、不高亮', () => {
  const html = slotHTML({ manualSource: 'carried-over' })
  assert.ok(!html.includes('data-last-resort'))
  assert.ok(!html.includes(MANUAL), '不展示旧命令')
  assert.ok(!/data-action="copy-manual"/.test(html), '不给复制')
  assert.ok(html.includes('手工命令尚未按当帧读数确认'), '给 stale 说明')
})

// ---------- 补读（#177 D3） ----------

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn))
    },
    click(attrs) {
      const el = {
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        getBoundingClientRect: () => ({ left: 100, top: 200, width: 80, height: 24 }),
      }
      const target = {
        closest: (sel) => {
          const m = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel)
          if (!m || !Object.prototype.hasOwnProperty.call(attrs, m[1])) return null
          if (m[2] !== undefined && attrs[m[1]] !== m[2]) return null
          return el
        },
      }
      for (const fn of [...(listeners.get('click') ?? [])]) fn({ target })
    },
  }
}

function mountPanel(box, call) {
  return mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000, autoChangelog: false })
}

/** 挂载后等首轮读数与自动查落定（click 落在忙态上会被忽略，必须先 settle）。 */
async function settledMount(box, call) {
  const panel = mountPanel(box, call)
  for (let i = 0; i < 6; i += 1) await tick()
  return panel
}

test('#174 补读：失败回包后静默补读一次，补到当帧命令 → 最后手段条', async () => {
  const box = fakeContainer()
  const calls = []
  const panel = await settledMount(box, async (name) => {
    calls.push(name)
    if (String(name).endsWith('.updateInstall')) return { ok: false, error: 'install-failed', errorKind: 'install-failed' }
    if (String(name).endsWith('.updateCheck')) {
      return { ok: true, snapshot: baseSnapshot({ canInstall: true }), manual: null, queue: null, receipt: { checkId: 'c1' } }
    }
    return { ok: true, snapshot: baseSnapshot({ canInstall: true }), manual: MANUAL, queue: null, receipt: { checkId: 'c1' } }
  })
  box.click({ 'data-action': 'install' })
  for (let i = 0; i < 6; i += 1) await tick()
  // 初始读数一次 + 失败回包后补读一次。
  assert.equal(calls.filter((n) => String(n).endsWith('.updateStatus')).length, 2, '失败后补读一次（仅一次）')
  assert.equal(calls.filter((n) => String(n).endsWith('.updateInstall')).length, 1)
  assert.ok(box.innerHTML.includes('data-kind="failed"'), '失败帧仍在')
  assert.ok(box.innerHTML.includes('data-last-resort="last-resort"'), '补读到的命令按当帧可信渲染')
  assert.ok(box.innerHTML.includes(MANUAL), '补读到的命令进 05 章')
  panel.unmount()
})

test('#174 补读：补读也失败 → 保持失败锁存、不展示命令、不再重试', async () => {
  const box = fakeContainer()
  const calls = []
  let statusRound = 0
  const panel = await settledMount(box, async (name) => {
    calls.push(name)
    if (String(name).endsWith('.updateInstall')) return { ok: false, error: 'install-failed', errorKind: 'install-failed' }
    if (String(name).endsWith('.updateCheck')) {
      return { ok: true, snapshot: baseSnapshot({ canInstall: true }), manual: null, queue: null, receipt: { checkId: 'c1' } }
    }
    statusRound += 1
    if (statusRound === 1) return { ok: true, snapshot: baseSnapshot({ canInstall: true }), manual: MANUAL, queue: null, receipt: { checkId: 'c1' } }
    return { ok: false, error: 'install-failed', errorKind: 'install-failed' }
  })
  box.click({ 'data-action': 'install' })
  for (let i = 0; i < 6; i += 1) await tick()
  assert.equal(calls.filter((n) => String(n).endsWith('.updateStatus')).length, 2, '只补读一次，不做重试循环')
  assert.ok(!box.innerHTML.includes('data-last-resort'), '没有当帧命令就不高亮')
  assert.ok(!bodyOf(box.innerHTML).includes('dsh-upd-copy-bubble'), '没有复制就没有气泡')
  assert.ok(box.innerHTML.includes('data-kind="failed"'), '失败锁存没被补读冲掉')
  await panel.refresh()
  await tick()
  assert.equal(calls.filter((n) => String(n).endsWith('.updateStatus')).length, 3, '后续轮询不再补读')
  panel.unmount()
})

// ---------- v1.3 复制气泡 ----------

test('#174 交互：复制成功浮出「已复制」气泡，按钮文案与图标不变', async () => {
  const box = fakeContainer()
  const panel = mountPanel(box, async () => ({ ok: true, snapshot: baseSnapshot({ canInstall: true }), manual: MANUAL, queue: null, receipt: null }))
  await tick()
  await tick()
  const before = box.innerHTML
  assert.ok(before.includes('复制手工命令'), '复制按钮初始文案')
  box.click({ 'data-action': 'copy-manual' })
  await tick()
  const after = box.innerHTML
  const afterBody = bodyOf(after)
  assert.ok(afterBody.includes('dsh-upd-copy-bubble'), '气泡出现')
  assert.ok(afterBody.includes('role="status"'), '气泡是状态提示')
  assert.ok(afterBody.includes('已复制'), '气泡文案')
  assert.equal((after.match(/复制手工命令/g) || []).length, (before.match(/复制手工命令/g) || []).length, '按钮文案一字不变')
  assert.ok(afterBody.includes('position:fixed'), '气泡用 fixed 定位，不挤压布局')
  panel.unmount()
})
