/**
 * tests/panel-seal-99.test.mjs —— 档案卷横幅小印章（#99）。
 *
 * 只测外部行为（本仓风格：断 CSS 串 + DOM，不断像素）：真布局由仓库外的
 * 量盒子探针验证（archive-en 各档章与标题同行、无越框、无重叠；restart 无章）。
 * 这里守的是"契约本身还在不在"，正是会复发的那四处：
 *   1. 真节点行内章：印章是横幅首行内的 span（伪元素在纵向 flex 里只能独占一行）；
 *   2. 框随文长：min-width + 自动伸展 + 不换行，英文词不再越框；
 *   3. 待重启档无章（标记是独立 SVG），data-mini 属性保留；
 *   4. 默认主题隐藏，内核 DOM 双主题逐字同一份。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UPDATE_PANEL_CSS, UPDATE_PANEL_ARCHIVE_CSS, renderUpdatePanelHTML } from '../dist/panel.js'

/** 小印章主规则块：第一个 `.dsh-upd-sealmini` 选择器所在规则的声明体。 */
function sealBlock() {
  const css = UPDATE_PANEL_ARCHIVE_CSS
  const at = css.indexOf('.dsh-upd-sealmini')
  assert.ok(at >= 0, 'Archive 串须有小印章行内节点样式')
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  assert.ok(open >= 0 && close > open, '小印章规则括号须配平')
  return css.slice(open, close + 1)
}

function baseInput(overrides = {}) {
  return {
    snapshot: {
      runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0',
      canInstall: true, blockedReason: null, job: null,
    },
    manual: null, queue: null, skippedLatest: false, lastError: null,
    mode: 'embedded', showOthers: false, pluginId: 'p', copyNotice: null, profileName: 'desktop',
    ...overrides,
  }
}

const SEAL_KINDS = ['loading', 'idle', 'update', 'busy', 'blocked', 'failed', 'done']

function snapshotFor(kind) {
  const snap = (over = {}) => ({
    runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0',
    canInstall: true, blockedReason: null, job: null, ...over,
  })
  switch (kind) {
    case 'loading': return null
    case 'busy': return snap({ job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' } })
    case 'blocked': return snap({ canInstall: false, blockedReason: 'unknown-profile' })
    case 'failed': return snap({ job: { id: 'j', state: 'failed', targetVersion: '1.1.0', message: 'install-failed: x', requestId: 'r' } })
    case 'done': return snap({ canInstall: false, latestVersion: '1.0.0' })
    case 'restart': return snap({ canInstall: false, blockedReason: 'pending-restart', latestVersion: '1.1.0', installedVersion: '1.1.0' })
    default: return snap()
  }
}

function bannerDOM(kind, lang, theme) {
  const html = renderUpdatePanelHTML(baseInput({
    snapshot: snapshotFor(kind),
    skippedLatest: kind === 'idle',
    manual: kind === 'failed' ? 'cmd' : null,
    theme,
  }), lang)
  const dom = html.replace(/<style>[\s\S]*?<\/style>/, '')
  const start = dom.indexOf('<div class="dsh-upd-banner"')
  assert.ok(start >= 0, `${kind}/${lang} 应有横幅`)
  return dom.slice(start, dom.indexOf('<div class="dsh-upd-strip"'))
}

describe('#99 档案卷横幅小印章（真节点行内章）', () => {
  test('行内章样式：行内盒 + 垂直居中 + 章在左字在右', () => {
    const block = sealBlock()
    assert.ok(block.includes('display:inline-flex'), '印章须是行内盒（与标题同一行）')
    assert.ok(block.includes('vertical-align:middle'), '印章须与标题文字垂直居中')
    assert.ok(block.includes('margin-right:10px'), '印章与标题须留 10px 字距（原型口径）')
    assert.ok(block.includes('transform:rotate(-5deg)'), '印章须旋转 -5°（原型 .sealmini）')
  })

  test('框随文长：中文外框与旧版一字不差，英文自动伸展', () => {
    const block = sealBlock()
    assert.ok(block.includes('min-width:34px'), '中文单字外框仍是 34px（含边框，与旧 30+2×2 一致）')
    assert.ok(block.includes('width:auto'), '框宽须随内容伸展（英文词不再越框）')
    assert.ok(block.includes('white-space:nowrap'), '印章文案不许折行（单行章）')
    assert.ok(block.includes('box-sizing:border-box'), 'min-width 须含边框与内边距')
    assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd-banner .dsh-upd-sealmini{min-width:28px'), '窄屏下限 28px（与旧 24+2×2 一致）')
  })

  test('DOM：六档带章、待重启档无章，章与 data-mini 同字', () => {
    for (const lang of ['zh', 'en']) {
      for (const kind of SEAL_KINDS) {
        const banner = bannerDOM(kind, lang, 'archive')
        const mini = /data-mini="([^"]*)"/.exec(banner)?.[1]
        assert.ok(mini !== undefined && mini.length > 0, `${kind}/${lang} 横幅须保留 data-mini`)
        assert.ok(
          banner.includes(`<span class="dsh-upd-sealmini" aria-hidden="true">${mini}</span><strong>`),
          `${kind}/${lang} 章须是标题 strong 紧邻左的行内节点且与 data-mini 同字`,
        )
      }
      const restart = bannerDOM('restart', lang, 'archive')
      assert.ok(!restart.includes('dsh-upd-sealmini'), `restart/${lang} 不得有章节点（标记是独立 SVG）`)
    }
  })

  test('默认主题隐藏：内核藏章，默认横幅仍带 data-mini 但无可见章', () => {
    assert.ok(
      UPDATE_PANEL_CSS.includes('.dsh-upd-banner>div:first-child>.dsh-upd-sealmini{display:none}'),
      '内核须默认隐藏行内章（修复只活在 Archive 串里）',
    )
    assert.ok(!UPDATE_PANEL_CSS.includes('attr(data-mini)'), '内核不许读 data-mini（印章只活在 Archive 皮肤）')
  })

  test('伪元素退役：横幅 ::before 不再画章', () => {
    assert.ok(
      !/\.dsh-upd-banner\[data-kind="[a-z]+"\]\s*::before\{content:attr\(data-mini\)/.test(UPDATE_PANEL_ARCHIVE_CSS),
      '横幅 ::before 不得再画章（章已是真节点；伪元素在纵向 flex 里只能独占一行）',
    )
  })

  test('标题行拉满：短标题不被收成窄块居中', () => {
    assert.ok(
      UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{flex:1 1 auto;min-width:0;align-self:stretch}'),
      '标题行须 align-self:stretch（纵向 flex + align-items:center 会把短标题居中，章跟着偏右）',
    )
  })
})
