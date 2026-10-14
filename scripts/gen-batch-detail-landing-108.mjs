/** scripts/gen-batch-detail-landing-108.mjs — #108 落地真渲染目检（双主题）。 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderBatchPanelHTML } from '../dist/panel-batch.js';

function baseQueue() {
  return { busy: false, owner: null, waiting: [], position: null };
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
    phoneNames: { updateCheck: 'demo.updateCheck' },
  };
}

const longChangelog = [
  '# Changelog', '',
  ...Array.from({ length: 15 }, (_, v) => [
    `## [9.9.${15 - v}] - 2026-10-11`, '',
    '### 新增',
    ...Array.from({ length: 6 }, (_, i) => `- 改进点 ${v + 1}-${i + 1}：详情弹窗内容区上下滑动验证行（章节头 sticky 归位）`), '',
    '### 修复',
    `- 修复点 ${v + 1}：超高内容被裁的回归验证行`, '',
  ]).flat(),
].join('\n');

const pageCss = [
  '.landing-page{max-width:1100px;margin:0 auto;padding:18px 16px 80px;font-family:system-ui,"Microsoft YaHei",sans-serif}',
  '.landing-banner{background:#ecfdf5;border:2px solid #059669;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.7;color:#064e3b;margin-bottom:16px}',
  '.landing-banner b{background:#059669;color:#fff;padding:1px 8px;border-radius:4px;margin-right:8px}',
  '.landing-sec{border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:16px 0;background:#fff}',
  '.landing-sec h2{margin:0 0 8px;font-size:16px}',
  '.landing-sec p{font-size:13px;line-height:1.7;color:#374151}',
  '.landing-sec code{background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:12px}',
  '.landing-stage{border-radius:12px;padding:28px 16px;display:flex;justify-content:center;background:rgba(0,0,0,.35)}',
  '.landing-stage .dsh-upd-overlay{position:static !important;display:block !important;background:transparent !important;padding:0 !important;z-index:auto !important}',
  '.landing-stage .dsh-upd-overlay .dsh-upd{margin:0 auto;max-height:85vh !important}',
  '.landing-stage .dsh-upd-overlay .dsh-upd-body{max-height:50vh !important;overflow-y:auto !important}',
].join('\n');

for (const theme of ['default', 'archive']) {
  const html = renderBatchPanelHTML({
    rows: [demoRow()],
    expandedKey: 'demo-plugin',
    changelogs: { 'demo-plugin': longChangelog },
    mode: 'dialog',
    theme,
    lang: 'zh',
    prefs: { checkOnOpen: true },
    loaded: true,
  });
  const page = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>LANDING #108 — 批量详情默认弹窗真渲染 · ${theme}</title>`,
    `<style>${pageCss}</style></head><body>`,
    '<div class="landing-page">',
    '<div class="landing-banner"><b>LANDING #108</b>批量详情默认弹窗真渲染（src 落地后 dist 直出，非原型占位）。校验：dialog 居中+遮罩、内容超高可滚、右下 footer 关闭、动作 5 件、双主题皮肤。</div>',
    `<div class="landing-sec"><h2>批量底 + 详情弹窗（${theme}，同一份 15 版长日志）</h2><p>批量底为 <code>dialog</code>，详情为 sibling <code>dsh-upd-bdetail-dialog</code>（<code>z-index:10000</code>）；动作行在弹窗内固定栏；关闭在右下 <code>footer</code>（<code>detail-close</code>，复用 <code>panel.footer.*</code> 文案）；Esc 先关详情再关批量。</p><div class="landing-stage">` + html + '</div></div>',
    '</div></body></html>',
  ].join('\n');
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(`artifacts/batch-detail-landing-${theme}.html`, page);
  console.log(`wrote artifacts/batch-detail-landing-${theme}.html (${page.length} chars)`);
}
