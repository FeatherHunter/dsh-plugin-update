/**
 * 原型生成器（#107）：批量详情默认弹窗双主题预览。
 * 只读渲染 dist，不写 src。复用单面板内核 dialog + 批量自出动作行。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { renderUpdatePanelHTML } from '../dist/panel.js'
import { renderBatchPanelHTML } from '../dist/panel-batch.js'

function baseQueue() {
  return { busy: false, owner: null, waiting: [], position: null }
}

function demoRow() {
  return {
    key: 'demo-plugin',
    title: '演示插件',
    phase: 'ready',
    targetVersion: '9.9.9',
    restartRequired: false,
    error: null,
    snapshot: {
      runningVersion: '1.0.0',
      installedVersion: '1.0.0',
      latestVersion: '9.9.9',
      canInstall: true,
      blockedReason: null,
      job: null,
    },
    manual: 'npm install demo-plugin@9.9.9',
    queue: baseQueue(),
    profileName: 'default',
    hostKind: 'test-host',
    phoneNames: { updateCheck: 'updateCheck', updateInstall: 'updateInstall' },
  }
}

const longChangelog = [
  '# Changelog',
  '',
  ...Array.from({ length: 15 }, (_, v) => [
    `## [9.9.${15 - v}] - 2026-10-11`,
    '',
    '### 新增',
    ...Array.from({ length: 6 }, (_, i) => `- 改进点 ${v + 1}-${i + 1}：详情弹窗内容区上下滑动验证行（章节头 sticky 归位）`),
    '',
    '### 修复',
    `- 修复点 ${v + 1}：超高内容被裁的回归验证行`,
    '',
  ]).flat(),
].join('\n')

function stripActionButtons(html) {
  return html.replace(/<button\b[^>]*data-action=[^>]*>[\s\S]*?<\/button>/g, '')
}

function extractDetailActions(theme) {
  const batch = renderBatchPanelHTML({
    rows: [demoRow()],
    expandedKey: 'demo-plugin',
    changelogs: { 'demo-plugin': longChangelog },
    mode: 'dialog',
    theme,
    lang: 'zh',
    prefs: { checkOnOpen: true },
    loaded: true,
  })
  const m = batch.match(/<span class="dsh-upd-bdetail-actions">[\s\S]*?<\/span>/)
  return m ? m[0] : '<span class="dsh-upd-bdetail-actions"></span>'
}

function buildPrototype(theme) {
  const row = demoRow()
  // 现状：批量 dialog + 内嵌展开（embedded 只读内核，overflow:visible 中性化）
  const statusHtml = renderBatchPanelHTML({
    rows: [row],
    expandedKey: 'demo-plugin',
    changelogs: { 'demo-plugin': longChangelog },
    mode: 'dialog',
    theme,
    lang: 'zh',
    prefs: { checkOnOpen: true },
    loaded: true,
  })

  // 原型：复用内核 dialog 只读 + 批量动作行前置为固定栏
  const kernelDialog = renderUpdatePanelHTML(
    {
      snapshot: row.snapshot,
      manual: row.manual,
      changelogMarkdown: longChangelog,
      queue: baseQueue(),
      skippedLatest: false,
      lastError: null,
      errorKind: null,
      mode: 'dialog',
      showOthers: false,
      pluginId: 'demo-plugin',
      copyNotice: null,
      theme,
      themeTokens: undefined,
      profileName: 'default',
      hostKind: 'test-host',
      actions: 'none',
    },
    'zh',
  )
  const stripped = stripActionButtons(kernelDialog)
  const actions = extractDetailActions(theme)
  // 把批量动作行注入为 dialog 内固定栏（利用已有的 flex:none 契约：非 .dsh-upd-body 子项不让高度）
  const bar =
    '<div class="dsh-upd-bdetail-dialog-bar" data-proto="batch-detail-bar">' +
    actions +
    '<button type="button" data-act="detail-close" title="Esc 也可关闭">关闭（Esc）</button></div>'
  // 内核 dialog 的结构是 overlay > .dsh-upd > ... > .dsh-upd-body；把 bar 插到 body 之前
  const protoDialog = stripped.replace(
    '<div class="dsh-upd-body">',
    bar + '<div class="dsh-upd-body">',
  )
  // 嵌套演示：原型 overlay 提高一层 z-index，滚动/关闭归属见页内说明
  const protoNested = protoDialog.replace(
    '<div class="dsh-upd-overlay"',
    '<div class="dsh-upd-overlay" style="z-index:10000"',
  )
  return { statusHtml, protoNested, actions }
}

const protoCss = [
  '.proto-page{max-width:1100px;margin:0 auto;padding:18px 16px 80px;font-family:system-ui,"Microsoft YaHei",sans-serif}',
  '.proto-banner{background:#fef08a;border:2px dashed #a16207;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.7;color:#422006;margin-bottom:16px}',
  '.proto-banner b{background:#111827;color:#fef08a;padding:1px 8px;border-radius:4px;margin-right:8px}',
  '.proto-sec{border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:16px 0;background:#fff}',
  '.proto-sec h2{margin:0 0 8px;font-size:16px}',
  '.proto-sec p{font-size:13px;line-height:1.7;color:#374151}',
  '.proto-sec code{background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:12px}',
  '.proto-stage{border-radius:12px;padding:28px 16px;display:flex;justify-content:center;background:rgba(0,0,0,.35)}',
  '.proto-stage .dsh-upd-overlay{position:static !important;display:block !important;background:transparent !important;padding:0 !important;z-index:auto !important}',
  '.proto-stage .dsh-upd-overlay .dsh-upd{margin:0 auto;max-height:85vh !important}',
  '.proto-stage .dsh-upd-overlay .dsh-upd-body{max-height:50vh !important;overflow-y:auto !important}',
  '.proto-stage-nested .dsh-upd-overlay{position:static !important}',
  '.dsh-upd-bdetail-dialog-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;margin-bottom:8px;border-bottom:1px dashed #e5e7eb}',
  '.dsh-upd-bdetail-dialog-bar .dsh-upd-bdetail-actions{margin:0}',
  '.dsh-upd-bdetail-dialog-bar [data-act=\"detail-close\"]{margin-left:auto}',
  '.proto-decisions{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.8}',
].join('\n')

for (const theme of ['default', 'archive']) {
  const { statusHtml, protoNested } = buildPrototype(theme)
  const html = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>PROTOTYPE #107 — 批量详情默认弹窗 · ${theme}</title>`,
    `<style>${protoCss}</style></head><body>`,
    '<div class="proto-page">',
    '<div class="proto-banner"><b>PROTOTYPE #107</b>批量详情默认弹窗确认 · 复用现成单面板内核 dialog，不新设计弹窗。你不用做原型，只看两段渲染后回答 6 个待定项（见底部）。本票不写 src。</div>',
    `<div class="proto-sec"><h2>0. 本页是什么（${theme}）</h2><p>上段 = <code>现状</code>：批量 dialog 内嵌展开（<code>mode:'embedded'</code> + <code>overflow:visible</code> 中性化），叠在批量面板上显示不全。下段 = <code>原型</code>：同一份详情内容改走 <code>renderUpdatePanelHTML(mode:'dialog', actions:'none')</code> + 批量自出动作行前置为固定栏 + <code>stripActionButtons</code> 延续。两段用同一份快照/长日志（30 版），可直接对比滚动与遮罩。</p></div>`,
    `<div class="proto-sec"><h2>A. 现状（内嵌展开的问题）</h2><p>批量本身已是 dialog，再内嵌展开详情：内容与批量面板共用一个滚动上下文，长日志把批量面板撑高、看不全；<code>.dsh-upd-bdetail</code> 中性化了 overlay 滚动，章节头也丢了 sticky。</p><div class="proto-stage">${statusHtml}</div></div>`,
    `<div class="proto-sec"><h2>B. 原型（默认弹窗：复用现成 dialog）</h2><p>遮罩 <code>rgba(0,0,0,.35)</code> 居中，框 <code>max-height:85vh</code> 纵向 flex，只有 <code>.dsh-upd-body</code> 滚动（<code>overflow-y:auto</code>），章节头 sticky 归位。动作行在弹窗内固定（flex:none，不跟随滚动）。关闭：右上“关闭（Esc）” + Esc，同单面板 <code>onCloseRequested</code> 口径；嵌套时内层只清 <code>expandedKey</code>，不碰批量 dialog。</p><div class="proto-stage proto-stage-nested">${protoNested}</div></div>`,
    '<div class="proto-sec proto-decisions"><h2>C. 请你确认的 6 项（回一句即可，供 #108 实施）</h2>',
    '1. 复用内核 dialog（85vh/遮罩/圆角）尺寸可否直接用？<br>',
    '2. 动作行置顶固定（不随内容滚）位置可否？<br>',
    '3. 嵌套关闭归属：详情 Esc/关闭只关详情、批量不动，可否？<br>',
    '4. 内容超高时只有弹窗 body 可滚（批量底不动），可否？<br>',
    '5. #84 口径（单查 row-check / 复制诊断 / 重试-队列 / 跳过-恢复 / 复制手工 / 死按钮摘除）原样保留，可否？<br>',
    '6. 默认不再保留内嵌展开：代码删还是留隐藏开关？（实现时二选一）</div>',
    '</div></body></html>',
  ].join('\n')
  mkdirSync('artifacts', { recursive: true })
  writeFileSync(`artifacts/batch-detail-dialog-${theme}.html`, html)
  console.log(`wrote artifacts/batch-detail-dialog-${theme}.html (${html.length} chars)`)
}
