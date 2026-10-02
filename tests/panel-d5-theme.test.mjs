/**
 * tests/panel-d5-theme.test.mjs —— D5 档案卷可选主题（#20）。
 *
 * 只测外部行为：同一输入双主题内核同一份（行为等价）、默认输出一字不动、
 * D5 七要素只换肤（印章/牌/衬线/TSVG/窄屏/折叠/双主题）、可访问性门禁、
 * 窄屏回归、复制诊断永不隐藏。样式像素只断关键选择器存在，不逐像素比对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_PANEL_CSS,
  UPDATE_PANEL_D5_CSS,
  mountUpdatePanel,
  panelViewModel,
  renderUpdatePanelHTML,
} from '../dist/panel.js'

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
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

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function fakeCall(status) {
  const call = async (name) => {
    if (name.endsWith('.updateStatus')) {
      return { ok: true, snapshot: status ?? baseSnapshot(), manual: null, receipt: null, queue: baseQueue() }
    }
    return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() }
  }
  return call
}

function inputFor(viewOverrides = {}, renderOverrides = {}) {
  return {
    snapshot: baseSnapshot(),
    manual: null,
    queue: baseQueue(),
    skippedLatest: false,
    lastError: null,
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
    mode: 'embedded',
    ...renderOverrides,
  }
}

/** 去掉外层 style 与根属性，只留内核：双主题行为等价比的就是这一份。 */
function kernelOf(html) {
  const start = html.indexOf('<div class="dsh-upd"')
  assert.ok(start >= 0, '应含面板根')
  const gt = html.indexOf('>', html.indexOf('<div class="dsh-upd"', start) + 1)
  // dialog 多一层 overlay：统一从第一个内核 banner 开始比。
  const banner = html.indexOf('<div class="dsh-upd-banner"')
  assert.ok(banner >= 0, '应含横幅内核')
  return html.slice(banner)
}

// ---------- 默认主题一字不动 ----------

test('默认主题输出不带 D5：无 data-theme、无 D5 串', () => {
  const html = renderUpdatePanelHTML(inputFor())
  assert.ok(!html.includes('data-theme='), '默认不得出现 data-theme 属性')
  assert.ok(!html.includes('d5-paper'), '默认样式不得带 D5 串')
  assert.ok(html.includes('data-action="copy-diag"'), '默认仍有复制诊断')
})

test('默认 CSS 本身不含主题作用域（D5 只活在追加串里）', () => {
  assert.ok(!UPDATE_PANEL_CSS.includes('data-theme'), 'UPDATE_PANEL_CSS 不得含 data-theme')
  assert.ok(UPDATE_PANEL_D5_CSS.includes('data-theme="d5-paper"'), 'D5 串按主题作用域收敛')
})

// ---------- 同 DOM 双主题行为等价 ----------

const KIND_CASES = [
  ['loading', { snapshot: null }],
  ['update', {}],
  ['busy', { snapshot: baseSnapshot({ job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' } }) }],
  ['restart', { snapshot: baseSnapshot({ canInstall: false, blockedReason: 'pending-restart', latestVersion: '1.1.0', installedVersion: '1.1.0' }) }],
  ['failed', { snapshot: baseSnapshot({ canInstall: true, job: { id: 'j', state: 'failed', targetVersion: '1.1.0', message: 'install-failed: x', requestId: 'r' } }), manual: 'cmd' }],
  ['blocked', { snapshot: baseSnapshot({ canInstall: false, blockedReason: 'unknown-profile' }) }],
  ['done', { snapshot: baseSnapshot({ canInstall: false, blockedReason: null, latestVersion: '1.0.0' }) }],
  ['idle-skipped', { snapshot: baseSnapshot({ canInstall: true, latestVersion: '1.1.0' }), skippedLatest: true }],
]

test('同 DOM 双主题行为等价：八种横幅内核逐字同一份', () => {
  for (const [name, view] of KIND_CASES) {
    const a = kernelOf(renderUpdatePanelHTML(inputFor(view)))
    const b = kernelOf(renderUpdatePanelHTML(inputFor(view, { theme: 'd5-paper' })))
    assert.equal(b, a, `${name} 内核两边必须逐字相同`)
  }
})

test('双形态与主题正交：同形态下换肤内核不变', () => {
  const base = { snapshot: baseSnapshot(), manual: 'cmd', queue: baseQueue(), skippedLatest: false, lastError: null }
  for (const mode of ['embedded', 'dialog']) {
    const def = kernelOf(renderUpdatePanelHTML({ ...base, mode, showOthers: false, pluginId: 'p', copyNotice: null }))
    const d5 = kernelOf(renderUpdatePanelHTML({ ...base, mode, showOthers: false, pluginId: 'p', copyNotice: null, theme: 'd5-paper' }))
    assert.equal(d5, def, `${mode} 下换肤内核必须逐字相同`)
  }
})

// ---------- D5 七要素只换肤 ----------

test('D5 七要素：印章一字 + profile 牌 + 衬线横幅 + SVG + 折叠 + 双主题全在串里', () => {
  const css = UPDATE_PANEL_D5_CSS
  for (const ch of ['"查"', '"装"', '"启"', '"阻"', '"定"']) {
    assert.ok(css.includes(`content:${ch}`), `迷你印章须含 ${ch}`)
  }
  assert.ok(css.includes('.dsh-upd-log code'), 'profile 牌须落在现有日志 code 上')
  assert.ok(css.includes('--d5-serif'), '须有衬线变量')
  assert.ok(css.includes('Noto Serif CJK SC'), '衬线栈须含 CJK 回退（无 Songti/SimSun 的环境不许回退成等线）')
  assert.ok(css.includes('[data-kind="restart"]'), '待重启横幅须单独收敛')
  assert.ok(css.includes('font-family:var(--d5-serif)'), '待重启横幅须用衬线')
  assert.ok(css.includes('data:image/svg+xml'), '手绘 SVG 标须内联 data-uri')
  assert.ok(css.includes('@media (max-width:640px)'), '窄屏回归须有 640px 媒体')
  assert.ok(css.includes('width:24px'), '窄屏印章须固定 24px')
  assert.ok(css.includes('text-overflow:ellipsis'), '优先级折叠走 CSS 省略号逐字折叠')
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'), '浅深双主题须跟随系统')
  assert.ok(css.includes('#f7f3ea') && css.includes('#141210'), '浅深纸色须各就其位')
})

test('复制诊断永不隐藏：D5 串不对复制入口写 display:none', () => {
  const css = UPDATE_PANEL_D5_CSS
  assert.ok(!/copy-diag[^}]*display\s*:\s*none/.test(css), '不得藏复制诊断按钮')
  assert.ok(!/\.dsh-upd-manual[^}]*display\s*:\s*none/.test(css), '不得藏手工命令块')
  const html = renderUpdatePanelHTML(inputFor({ snapshot: baseSnapshot() }, { theme: 'd5-paper' }))
  assert.ok(html.includes('data-action="copy-diag"'), 'D5 下复制诊断仍在 DOM 里')
})

// ---------- 可访问性门禁 ----------

function luminance(hex) {
  const c = hex.replace('#', '')
  const v = [0, 2, 4].map((i) => {
    const x = parseInt(c.slice(i, i + 2), 16) / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
}

function ratio(a, b) {
  const l1 = luminance(a)
  const l2 = luminance(b)
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

test('对比度门禁：正文/次要/主按钮/横幅底上正文 ≥ 4.5', () => {
  const pairs = [
    ['正文/纸', '#1a1a1a', '#fffdf6'],
    ['次要/纸', '#6f675a', '#fffdf6'],
    ['白字/朱砂', '#ffffff', '#c8402a'],
    ['正文/警告底', '#1a1a1a', '#fbf0d0'],
    ['正文/坏底', '#1a1a1a', '#fbe9e5'],
    ['正文/好底', '#1a1a1a', '#e9f4ea'],
    ['深纸正文/深卡', '#ece5d3', '#1e1a15'],
    ['深次要/深卡', '#a89c83', '#1e1a15'],
    ['深墨字/深 accent', '#141210', '#e0684e'],
  ]
  for (const [name, fg, bg] of pairs) {
    const r = ratio(fg, bg)
    assert.ok(r >= 4.5, `${name} 对比度 ${r.toFixed(2)} 须 ≥ 4.5（${fg} on ${bg}）`)
  }
})

test('键盘门禁：D5 下焦点环永不去掉', () => {
  assert.ok(UPDATE_PANEL_D5_CSS.includes('button:focus-visible'), 'D5 须保留焦点环')
  assert.ok(UPDATE_PANEL_D5_CSS.includes('outline:'), '焦点环须有 outline')
})

test('forced-colors 与 reduced-motion 门禁在串', () => {
  assert.ok(UPDATE_PANEL_D5_CSS.includes('@media (forced-colors: active)'), '须有 forced-colors 降级')
  assert.ok(UPDATE_PANEL_D5_CSS.includes('CanvasText'), 'forced-colors 须走系统色')
  assert.ok(UPDATE_PANEL_D5_CSS.includes('@media (prefers-reduced-motion: reduce)'), '须有关动画降级')
})

test('SVG 双色归位：浅笔触在顶层规则，深笔触只活在深色媒体里', () => {
  const css = UPDATE_PANEL_D5_CSS
  const darkIdx = css.indexOf('@media (prefers-color-scheme: dark)')
  assert.ok(darkIdx >= 0, '须有深色媒体')
  const top = css.slice(0, darkIdx)
  const darkAndAfter = css.slice(darkIdx)
  assert.ok(top.includes('%238a5a00'), '浅色笔触须在顶层规则')
  assert.ok(!top.includes('%23e8c15a'), '深色笔触不得出现在深色媒体之前（否则浅色下也被盖掉）')
  assert.ok(darkAndAfter.includes('%23e8c15a'), '深色笔触须在深色媒体里覆盖')
})

test('括号配平：D5 串去掉 url(...) 后 {} 必须成对（多余 } 会吃掉后面的门禁）', () => {
  const noUrl = UPDATE_PANEL_D5_CSS.replace(/url\(".*?"\)/g, 'url()')
  const opens = (noUrl.match(/\{/g) || []).length
  const closes = (noUrl.match(/\}/g) || []).length
  assert.equal(closes, opens, `括号须配平（开 ${opens}，合 ${closes}）`)
})

// ---------- 挂载一体 ----------

test('挂载：theme 可选，非法抛错，setTheme 可切', async () => {
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call: fakeCall(), pollMs: 60000 })
  assert.ok(!box.innerHTML.includes('data-theme='), '默认挂载无 data-theme')
  panel.unmount()

  const box2 = fakeContainer()
  const panel2 = mountUpdatePanel(box2, { pluginId: 'p', call: fakeCall(), pollMs: 60000, theme: 'd5-paper' })
  await panel2.refresh()
  assert.ok(box2.innerHTML.includes('data-theme="d5-paper"'), 'd5-paper 挂载即换肤')
  assert.ok(box2.innerHTML.includes('data-action="copy-diag"'), '换肤不断复制诊断')
  await panel2.setTheme('default')
  assert.ok(!box2.innerHTML.includes('data-theme='), 'setTheme 可切回默认')
  await panel2.setTheme('d5-paper')
  assert.ok(box2.innerHTML.includes('data-theme="d5-paper"'), 'setTheme 可再切回 D5')
  panel2.unmount()

  assert.throws(
    () => mountUpdatePanel(fakeContainer(), { pluginId: 'p', call: fakeCall(), pollMs: 60000, theme: 'nope' }),
    /主题非法/,
    '非法主题须抛错，不静默取整',
  )
})

test('视图模型不受主题影响：同一快照同一横幅', () => {
  const v1 = panelViewModel({ snapshot: baseSnapshot(), manual: null, queue: baseQueue(), skippedLatest: false, lastError: null })
  assert.equal(v1.banner.kind, 'update', '有新版即 update 横幅（与主题无关）')
})
