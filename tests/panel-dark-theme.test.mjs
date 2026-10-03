/**
 * tests/panel-dark-theme.test.mjs —— 默认主题的深色可读性回归（现场报告：深色下更新横幅白底浅字）。
 *
 * 只测外部行为/产物：从导出的 CSS 里取出「横幅配色」与「深色覆盖」两段，断言
 *   ① 四种横幅（更新/待重启/失败/忙）的底色与边线都走变量，不许硬编码浅色；
 *   ② 深色媒体块把八条变量全部覆盖（漏一条就会退回浅色原值）；
 *   ③ 深色下「浅字 × 横幅底色（按透明度合成到面板底色）」对比度 ≥ 4.5。
 * 这三条正是现场那个 bug 的三道门：漏①或②就白底，漏③就浅底浅字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UPDATE_PANEL_CSS } from '../dist/panel.js'

const KINDS = ['update', 'restart', 'failed', 'busy']
const VAR_NAMES = [
  '--dsh-upd-ok-bg', '--dsh-upd-ok-line',
  '--dsh-upd-warn-bg', '--dsh-upd-warn-line',
  '--dsh-upd-bad-bg', '--dsh-upd-bad-line',
  '--dsh-upd-busy-bg', '--dsh-upd-busy-line',
]

function bannerRules() {
  return UPDATE_PANEL_CSS.split('\n').filter((l) => /\.dsh-upd-banner\[data-kind=/.test(l))
}

function darkBlock() {
  const idx = UPDATE_PANEL_CSS.indexOf('prefers-color-scheme: dark')
  assert.ok(idx > 0, '默认主题缺少深色媒体块')
  return UPDATE_PANEL_CSS.slice(idx, UPDATE_PANEL_CSS.indexOf('}', idx) + 1)
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test('横幅四种状态的底色与边线都走变量，不硬编码浅色', () => {
  const rules = bannerRules()
  for (const kind of KINDS) {
    const hit = rules.filter((l) => l.includes(`data-kind="${kind}"`))
    assert.ok(hit.length > 0, `缺少 [data-kind="${kind}"] 横幅规则`)
    for (const line of hit) {
      const decls = line.slice(line.indexOf('{'))
      assert.match(decls, /background:var\(--dsh-upd-[a-z]+-bg\)/, `${kind}：底色必须走变量`)
      assert.match(decls, /border-color:var\(--dsh-upd-[a-z]+-line\)/, `${kind}：边线必须走变量`)
      assert.doesNotMatch(decls, /(background|border-color):#/, `${kind}：不许硬编码颜色（深色会读不出来）`)
    }
  }
})

test('深色媒体块覆盖全部八条横幅变量（漏一条就退回浅色）', () => {
  const block = darkBlock()
  for (const name of VAR_NAMES) {
    assert.ok(block.includes(name + ':'), `深色块缺 ${name}，深色下会退回浅色原值`)
  }
})

test('深色下文字与横幅底色对比度 ≥ 4.5（浅字浅底的门）', () => {
  const block = darkBlock()
  const fgMatch = block.match(/--dsh-upd-fg:(#[0-9a-fA-F]{3,6})/)
  const panelMatch = block.match(/--dsh-upd-bg:(#[0-9a-fA-F]{3,6})/)
  assert.ok(fgMatch && panelMatch, '深色块必须给 --dsh-upd-fg 与 --dsh-upd-bg')
  const fg = hexToRgb(fgMatch[1])
  const panel = hexToRgb(panelMatch[1])
  for (const name of VAR_NAMES.filter((n) => n.endsWith('-bg'))) {
    const m = block.match(new RegExp(name.replace(/-/g, '\\-') + ':rgba\\(([^)]+)\\)'))
    assert.ok(m, `${name} 深色值应为低透明度同色系 rgba(...)`)
    const [r, g, b, a] = m[1].split(',').map((s) => Number(s.trim()))
    const composited = [r, g, b].map((c, i) => Math.round(c * a + panel[i] * (1 - a)))
    const ratio = contrast(fg, composited)
    assert.ok(ratio >= 4.5, `${name} 深色下对比度只有 ${ratio.toFixed(2)}：浅底浅字读不出来`)
  }
})
