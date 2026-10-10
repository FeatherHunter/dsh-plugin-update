/**
 * tests/panel-archive-theme.test.mjs —— Archive 档案卷可选主题（#20）。
 *
 * 只测外部行为：同一输入双主题内核同一份（行为等价）、默认输出一字不动、
 * Archive 七要素只换肤（印章/牌/衬线/TSVG/窄屏/折叠/双主题）、可访问性门禁、
 * 窄屏回归、复制诊断永不隐藏。样式像素只断关键选择器存在，不逐像素比对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_PANEL_CSS,
  UPDATE_PANEL_ARCHIVE_CSS,
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
    // 两个参数都真的并进来（此前第一个参数被忽略，用它会静默拿到默认快照）。
    ...viewOverrides,
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

test('默认主题输出不带 Archive：无 data-theme、无 Archive 串', () => {
  const html = renderUpdatePanelHTML(inputFor())
  assert.ok(!html.includes('data-theme='), '默认不得出现 data-theme 属性')
  assert.ok(!html.includes('archive'), '默认样式不得带 Archive 串')
  assert.ok(html.includes('data-action="copy-diag"'), '默认仍有复制诊断')
})

test('默认 CSS 本身不含主题作用域（Archive 只活在追加串里）', () => {
  assert.ok(!UPDATE_PANEL_CSS.includes('data-theme'), 'UPDATE_PANEL_CSS 不得含 data-theme')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('data-theme="archive"'), 'Archive 串按主题作用域收敛')
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
    const b = kernelOf(renderUpdatePanelHTML(inputFor(view, { theme: 'archive' })))
    assert.equal(b, a, `${name} 内核两边必须逐字相同`)
  }
})

test('双形态与主题正交：同形态下换肤内核不变', () => {
  const base = { snapshot: baseSnapshot(), manual: 'cmd', queue: baseQueue(), skippedLatest: false, lastError: null }
  for (const mode of ['embedded', 'dialog']) {
    const def = kernelOf(renderUpdatePanelHTML({ ...base, mode, showOthers: false, pluginId: 'p', copyNotice: null }))
    const arch = kernelOf(renderUpdatePanelHTML({ ...base, mode, showOthers: false, pluginId: 'p', copyNotice: null, theme: 'archive' }))
    assert.equal(arch, def, `${mode} 下换肤内核必须逐字相同`)
  }
})

// ---------- Archive 七要素只换肤 ----------

test('Archive 七要素：印章取属性 + profile 牌 + 衬线横幅 + SVG + 折叠 + 双主题全在串里', () => {
  const css = UPDATE_PANEL_ARCHIVE_CSS
  // 印章（原型 :206 大印章 / :215 小印章）：大印章内容从根属性取；小印章是首行内真节点
  // （#99：伪元素在纵向 flex 里只能独占一行，纯 CSS 走不通），CSS 只给行内章上肤。
  assert.ok(css.includes('content:attr(data-seal)'), '大印章须读 data-seal')
  assert.ok(css.includes('.dsh-upd-sealmini'), '小印章须有行内节点样式（真节点，不再是 ::before 伪元素）')
  assert.ok(css.includes('rotate(-7deg)'), '大印章须旋转 -7°（原型 .seal）')
  assert.ok(css.includes('[data-seal-tone="green"]'), '大印章须按色调分档上色')
  assert.ok(css.includes('.dsh-upd-log code'), 'profile 牌须落在现有日志 code 上')
  assert.ok(css.includes('--dsh-update-font-serif'), '须有衬线变量')
  assert.ok(css.includes('Noto Serif CJK SC'), '衬线栈须含 CJK 回退（无 Songti/SimSun 的环境不许回退成等线）')
  assert.ok(css.includes('[data-kind="restart"]'), '待重启横幅须单独收敛')
  assert.ok(css.includes('font-family:var(--dsh-update-font-serif)'), '待重启横幅须用衬线')
  assert.ok(css.includes('data:image/svg+xml'), '手绘 SVG 标须内联 data-uri')
  assert.ok(css.includes('@media (max-width:640px)'), '窄屏回归须有 640px 媒体')
  assert.ok(css.includes('min-width:28px'), '窄屏印章下限 28px 外框、不被挤掉（#99：与旧 24+2×2 外框一致，英文词可伸展）')
  assert.ok(css.includes('text-overflow:ellipsis'), '优先级折叠走 CSS 省略号逐字折叠')
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'), '浅深双主题须跟随系统')
  assert.ok(css.includes('#f7f3ea') && css.includes('#141210'), '浅深纸色须各就其位')
})

test('待重启横幅只有一个标记：不画印章，标记是手绘 SVG（原型 :446）', () => {
  const css = UPDATE_PANEL_ARCHIVE_CSS
  // 印章选择器列表里不许出现 restart（否则「启」章与 SVG 三角两个标记打架——现场就是这个问题）。
  // #99：印章是真节点，选择器形如 `[data-kind="x"] .dsh-upd-sealmini`（含空格后代）。
  const sealSelectors = css.split('}').filter((chunk) => chunk.includes('.dsh-upd-sealmini'))
  assert.ok(sealSelectors.length > 0, '小印章样式规则必须还在')
  for (const sel of sealSelectors) {
    assert.ok(!sel.includes('data-kind="restart"'), '待重启横幅不得挂迷你印章：' + sel.slice(0, 120))
  }
  assert.ok(
    !/\[data-kind="restart"\]::before\{content:/.test(css),
    '待重启横幅不得有 content 规则（标记只能是 SVG）',
  )
  assert.ok(
    css.includes('[data-kind="restart"]>div:first-child{display:flex'),
    '待重启标记须是独立 flex 标记（不许用行内背景把句子劈开）',
  )
  assert.ok(css.includes('[data-kind="restart"]>div:first-child::before{content:""'), '标记走 ::before 占位，不挤正文')
})

test('印章走属性带在根上：两个主题的内核逐字同一份，默认主题不画', () => {
  const restartInput = inputFor({
    snapshot: baseSnapshot({ canInstall: false, blockedReason: 'pending-restart', latestVersion: '1.1.0', installedVersion: '1.1.0' }),
  })
  const def = renderUpdatePanelHTML(restartInput)
  const arch = renderUpdatePanelHTML({ ...restartInput, theme: 'archive' })
  assert.ok(def.includes('data-seal="待重启"'), '根上须带大印章文字')
  assert.ok(def.includes('data-seal-tone="yellow"'), '待重启印章色调应为黄')
  assert.ok(def.includes('data-mini="启"'), '横幅须带小印章一字')
  assert.equal(kernelOf(arch), kernelOf(def), '换肤不得改内核')
  assert.ok(!UPDATE_PANEL_CSS.includes('attr(data-seal)'), '默认主题不许画印章（内容只在 Archive 串里读）')
})

test('待重启文案照原型：不带 emoji，且给「请重启DSH」入口', () => {
  const html = renderUpdatePanelHTML(
    inputFor({ snapshot: baseSnapshot({ canInstall: false, blockedReason: 'pending-restart', latestVersion: '1.1.0', installedVersion: '1.1.0' }) }),
  )
  assert.ok(html.includes('新版 1.1.0 已安装，重启宿主后生效。'), '文案须照原型')
  assert.ok(!html.includes('⚠'), '标题里不得再有 emoji（标记由 SVG 承担）')
  assert.ok(html.includes('data-action="restart-hint"'), '须给「请重启DSH」入口')
  assert.ok(html.includes('>请重启DSH<'), '按钮文字须是「请重启DSH」')
  assert.ok(!html.includes('data-action="restart-hint" data-primary'), '诚实化：重启入口不再是主按钮')
  assert.ok(html.includes('title="点一下走调用方流程，没有就手动重启 DSH"') || html.includes('title="Run the caller restart flow'), '悬停须是新口径（走调用方流程/手动重启DSH）')
})

test('「请重启DSH」入口：没给回调如实提示手动重启，给了回调就交给调用方', async () => {
  const restart = baseSnapshot({ canInstall: false, blockedReason: 'pending-restart', latestVersion: '1.1.0', installedVersion: '1.1.0' })
  const boxA = fakeContainer()
  const panelA = mountUpdatePanel(boxA, { pluginId: 'p', call: fakeCall(restart), pollMs: 60000 })
  await panelA.refresh()
  await panelA.act('restart-hint')
  assert.ok(boxA.innerHTML.includes('请手动重启宿主'), '没给回调须如实提示，不假装能重启')
  panelA.unmount()

  let called = 0
  const boxB = fakeContainer()
  const panelB = mountUpdatePanel(boxB, {
    pluginId: 'p',
    call: fakeCall(restart),
    pollMs: 60000,
    onRestartRequested: () => {
      called += 1
    },
  })
  await panelB.refresh()
  await panelB.act('restart-hint')
  assert.equal(called, 1, '给了回调须调用它')
  assert.ok(boxB.innerHTML.includes('已按调用方的重启流程处理'), '须如实回执')
  panelB.unmount()
})

test('「请重启DSH」入口抛错回退手动重启提示', async () => {
  const restart = baseSnapshot({ canInstall: false, blockedReason: 'pending-restart', latestVersion: '1.1.0', installedVersion: '1.1.0' })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    call: fakeCall(restart),
    pollMs: 60000,
    onRestartRequested: () => {
      throw new Error('restart-boom')
    },
  })
  await panel.refresh()
  await panel.act('restart-hint')
  assert.ok(box.innerHTML.includes('重启入口调用失败'), '调用方流程抛错须回退手动重启提示')
  panel.unmount()
})

test('复制诊断永不隐藏：Archive 串不对复制入口写 display:none', () => {
  const css = UPDATE_PANEL_ARCHIVE_CSS
  assert.ok(!/copy-diag[^}]*display\s*:\s*none/.test(css), '不得藏复制诊断按钮')
  assert.ok(!/\.dsh-upd-manual[^}]*display\s*:\s*none/.test(css), '不得藏手工命令块')
  const html = renderUpdatePanelHTML(inputFor({ snapshot: baseSnapshot() }, { theme: 'archive' }))
  assert.ok(html.includes('data-action="copy-diag"'), 'Archive 下复制诊断仍在 DOM 里')
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

test('键盘门禁：Archive 下焦点环永不去掉', () => {
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('button:focus-visible'), 'Archive 须保留焦点环')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('outline:'), '焦点环须有 outline')
})

test('forced-colors 与 reduced-motion 门禁在串', () => {
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('@media (forced-colors: active)'), '须有 forced-colors 降级')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('CanvasText'), 'forced-colors 须走系统色')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('@media (prefers-reduced-motion: reduce)'), '须有关动画降级')
})

test('SVG 双色归位：浅笔触在顶层规则，深笔触只活在深色媒体里', () => {
  const css = UPDATE_PANEL_ARCHIVE_CSS
  const darkIdx = css.indexOf('@media (prefers-color-scheme: dark)')
  assert.ok(darkIdx >= 0, '须有深色媒体')
  const top = css.slice(0, darkIdx)
  const darkAndAfter = css.slice(darkIdx)
  assert.ok(top.includes('%238a5a00'), '浅色笔触须在顶层规则')
  assert.ok(!top.includes('%23e8c15a'), '深色笔触不得出现在深色媒体之前（否则浅色下也被盖掉）')
  assert.ok(darkAndAfter.includes('%23e8c15a'), '深色笔触须在深色媒体里覆盖')
})

test('括号配平：Archive 串去掉 url(...) 后 {} 必须成对（多余 } 会吃掉后面的门禁）', () => {
  const noUrl = UPDATE_PANEL_ARCHIVE_CSS.replace(/url\(".*?"\)/g, 'url()')
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
  const panel2 = mountUpdatePanel(box2, { pluginId: 'p', call: fakeCall(), pollMs: 60000, theme: 'archive' })
  await panel2.refresh()
  assert.ok(box2.innerHTML.includes('data-theme="archive"'), 'archive 挂载即换肤')
  assert.ok(box2.innerHTML.includes('data-action="copy-diag"'), '换肤不断复制诊断')
  await panel2.setTheme('default')
  assert.ok(!box2.innerHTML.includes('data-theme='), 'setTheme 可切回默认')
  await panel2.setTheme('archive')
  assert.ok(box2.innerHTML.includes('data-theme="archive"'), 'setTheme 可再切回档案卷')
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
