/**
 * tests/panel-fontsize-tokens.test.mjs —— 面板正文字号参数化（#103）。
 *
 * 只测外部行为：新 token 序列化（合法收/非法即抛，与现有口径一致）+
 * 双主题 × dialog/embedded 下根上写变量、不传零回归（无 style）+
 * 批量面板同语义 + CSS 变量回退（不传即旧值）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  themeTokensStyleFor,
  UPDATE_PANEL_CSS,
  UPDATE_PANEL_ARCHIVE_CSS,
  renderUpdatePanelHTML,
} from '../dist/panel.js'
import { UPDATE_BATCH_PANEL_CSS, UPDATE_BATCH_PANEL_ARCHIVE_CSS, renderBatchPanelHTML } from '../dist/panel-batch.js'

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

function panelInput(overrides = {}) {
  return {
    snapshot: baseSnapshot(), manual: null, queue: { busy: false, owner: null, waiting: [], position: null },
    skippedLatest: false, lastError: null, showOthers: false, pluginId: 'p', copyNotice: null,
    mode: 'embedded', ...overrides,
  }
}

describe('新 token 序列化（与现有口径一致）', () => {
  test('五个字号键合法即收，输出变量名一一对应', () => {
    assert.equal(
      themeTokensStyleFor({ panelFontSize: '18px' }),
      '--dsh-update-panel-font-size:18px',
    )
    assert.equal(
      themeTokensStyleFor({ panelChapterFontSize: '20px' }),
      '--dsh-update-panel-chapter-font-size:20px',
    )
    assert.equal(
      themeTokensStyleFor({ panelBannerTitleFontSize: '30px' }),
      '--dsh-update-panel-banner-title-font-size:30px',
    )
    assert.equal(
      themeTokensStyleFor({ panelLogFontSize: '15px' }),
      '--dsh-update-panel-log-font-size:15px',
    )
    assert.equal(
      themeTokensStyleFor({ panelSmallFontSize: '13px' }),
      '--dsh-update-panel-small-font-size:13px',
    )
  })

  test('非法即抛：空串/注入/非字符串，与现有口径一致', () => {
    assert.throws(() => themeTokensStyleFor({ panelFontSize: '' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ panelFontSize: '   ' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ panelChapterFontSize: '14px;hack' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ panelBannerTitleFontSize: '27px"' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ panelLogFontSize: '13px}evil' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ panelSmallFontSize: '12px!important' }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ panelFontSize: 14 }), /themeTokens/)
    assert.throws(() => themeTokensStyleFor({ panelFontSize: 'x'.repeat(201) }), /themeTokens/)
  })
})

describe('双主题 × dialog/embedded 下变量生效、无 style 时零回归', () => {
  const tokens = {
    panelFontSize: '18px',
    panelChapterFontSize: '20px',
    panelBannerTitleFontSize: '30px',
    panelLogFontSize: '15px',
    panelSmallFontSize: '13px',
  }
  const vars = [
    '--dsh-update-panel-font-size:18px',
    '--dsh-update-panel-chapter-font-size:20px',
    '--dsh-update-panel-banner-title-font-size:30px',
    '--dsh-update-panel-log-font-size:15px',
    '--dsh-update-panel-small-font-size:13px',
  ]

  for (const theme of ['default', 'archive']) {
    for (const mode of ['embedded', 'dialog']) {
      test(`单面板 ${theme}/${mode}：传了写根上`, () => {
        const input = panelInput({ mode, themeTokens: tokens })
        if (theme === 'archive') input.theme = 'archive'
        const html = renderUpdatePanelHTML(input)
        for (const v of vars) assert.ok(html.includes(v), `${theme}/${mode} 根上须有 ${v}`)
        if (theme === 'archive') assert.ok(html.includes('data-theme="archive"'), '主题属性仍在')
      })
    }
  }

  test('单面板：不传无 style（零回归，DOM 与旧版一致）', () => {
    const plain = renderUpdatePanelHTML(panelInput())
    assert.ok(!plain.includes(' style="--dsh-update-'), '不传不得出现变量 style')
    const plainArchive = renderUpdatePanelHTML(panelInput({ theme: 'archive' }))
    assert.ok(!plainArchive.includes(' style="--dsh-update-'), 'archive 不传也不得出现变量 style')
    const plainDialog = renderUpdatePanelHTML(panelInput({ mode: 'dialog' }))
    assert.ok(!plainDialog.includes(' style="--dsh-update-'), 'dialog 不传也不得出现变量 style')
  })

  test('批量面板：传了写根上，不传无 style', () => {
    const withTokens = renderBatchPanelHTML({ rows: [], themeTokens: tokens })
    for (const v of vars) assert.ok(withTokens.includes(v), `批量根上须有 ${v}`)
    const plain = renderBatchPanelHTML({ rows: [] })
    assert.ok(!plain.includes(' style="--dsh-update-'), '批量不传不得出现变量 style')
  })

  test('纯渲染非法即抛（新键坏值）', () => {
    assert.throws(() => renderUpdatePanelHTML(panelInput({ themeTokens: { panelFontSize: '' } })), /themeTokens/)
    assert.throws(() => renderBatchPanelHTML({ rows: [], themeTokens: { panelSmallFontSize: '12px;hack' } }), /themeTokens/)
  })
})

describe('CSS 变量回退（不传即旧值）', () => {
  test('默认 CSS 读变量，回退即旧硬编码', () => {
    assert.ok(UPDATE_PANEL_CSS.includes('font:var(--dsh-update-panel-font-size,14px)/1.75'), '正文基准回退 14px')
    assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-chap-title{font-size:var(--dsh-update-panel-chapter-font-size,14px)'), '章节标题回退 14px')
    assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-banner>div:first-child strong{font-size:var(--dsh-update-panel-banner-title-font-size,inherit)}'), '横幅标题默认继承')
    assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-manual,.dsh-upd-queue,.dsh-upd-log{margin:4px 0;font-size:var(--dsh-update-panel-log-font-size,13px)}'), '日志回退 13px')
    assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-banner-sub{font-size:var(--dsh-update-panel-small-font-size,12.5px)'), '副行回退 12.5px')
  })

  test('Archive CSS 读变量，回退即原型值', () => {
    assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd-chap-title{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-chapter-font-size,17px)'), '档案章节 17px')
    assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('font-size:var(--dsh-update-panel-banner-title-font-size,27px)'), '档案横幅 27px')
    assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('font-size:var(--dsh-update-panel-banner-title-font-size,24px)'), '档案已最新 24px')
    assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('font-size:var(--dsh-update-panel-log-font-size,13.5px)}'), '档案日志体 13.5px')
  })

  test('批量 CSS 同语义（标题走章节，汇总走日志）', () => {
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-batch-title{font-weight:700;font-size:var(--dsh-update-panel-chapter-font-size,15px)'), '批量标题 15px')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-batch-sum{margin:4px 0 8px;font-size:var(--dsh-update-panel-log-font-size,13.5px)}'), '批量汇总 13.5px')
    assert.ok(UPDATE_BATCH_PANEL_ARCHIVE_CSS.includes('font-size:var(--dsh-update-panel-chapter-font-size,21px)'), '批量档案标题 21px')
  })
})
