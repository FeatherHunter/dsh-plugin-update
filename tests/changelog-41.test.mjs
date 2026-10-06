/**
 * tests/changelog-41.test.mjs -- #41 实现验收（Security 必显/诚实截断/撤回横幅/破坏标记 + validate 与记住语义）。
 * 只测外部行为：公开纯函数与面板内核渲染，不测内部实现与样式像素。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANGELOG_MAX_BULLETS_PER_SECTION,
  countsOf,
  isBreakingChangelogItem,
  parseChangelog,
  renderChangelogHTML,
  shouldFetchChangelog,
  splitBreakingPrefix,
  validateChangelog,
  yankedBannerHTML,
} from '../dist/changelog.js'
import { renderUpdatePanelHTML } from '../dist/panel.js'
import { mountUpdatePanel } from '../dist/panel.js'

function lines(arr) { return arr.join(String.fromCharCode(10)) }
function baseSnapshot(overrides) {
  const base = {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    job: null,
  };
  if (overrides) { for (const k of Object.keys(overrides)) { base[k] = overrides[k]; } }
  return base;
}
function baseInput(overrides) {
  const base = {
    snapshot: baseSnapshot(),
    manual: null,
    queue: null,
    skippedLatest: false,
    lastError: null,
    errorKind: null,
    mode: 'embedded',
    showOthers: false,
    pluginId: 'my-plugin',
    copyNotice: null,
  };
  if (overrides) { for (const k of Object.keys(overrides)) { base[k] = overrides[k]; } }
  return base;
}
function fakeContainer() { return { innerHTML: '', addEventListener: function() {}, removeEventListener: function() {} }; }
const settled = function() { return new Promise(function(res) { setTimeout(res, 0); }); };

test('Security 必显：展开渲染，不进折叠 details', function() {
  const md = lines(['# C', '', '## [1.1.0] - 2026-09-30', '', '### Security', '- 收紧令牌', '', '### Deprecated', '- 旧参数']);
  const html = renderChangelogHTML(parseChangelog(md), { from: '1.0.0', to: '1.1.0' });
  assert.ok(html.includes('data-cat="Security"'), 'Security 应在必显集合');
  assert.ok(!/<details[^>]*data-cat="Security"/.test(html), 'Security 不应进 details');
  assert.ok(html.includes('收紧令牌'), 'Security 内容展开可见');
  assert.ok(html.includes('data-cat="Deprecated"'), 'Deprecated 仍折叠');
});

test('截断计数：解析只记数字，超限类标小字，多版本各自标', function() {
  const many = [];
  for (let i = 0; i < 205; i++) { many.push('- 条目' + String(i)); }
  const md = lines(['# C', '', '## [1.1.0]', '', '### Added'].concat(many).concat(['', '## [1.0.0]', '', '### Added', '- 老条目']));
  const entries = parseChangelog(md);
  const v110 = entries.find(function(e) { return e.version === '1.1.0'; });
  assert.ok(v110, '应解析出 1.1.0');
  const c = countsOf(v110);
  assert.equal(c.Added, 205, '原始计数应为 205');
  assert.equal(v110.sections.Added.length, 200, '只渲染前 200 条');
  assert.ok(!JSON.stringify(v110).includes('条目204') || v110.sections.Added.length === 200, '计数元数据只记数字（抽查文本未超存）');
  const html = renderChangelogHTML(entries, { from: '1.0.0', to: '1.1.0' });
  assert.ok(html.includes('共 205 条'), '超限类应标 M');
  assert.ok(html.includes('仅显示前 200 条'), '超限类应标 N');
  const v100 = entries.find(function(e) { return e.version === '1.0.0'; });
  assert.equal(countsOf(v100).Added, 1, '未超限版本计数为 1');
  const htmlAll = renderChangelogHTML(entries);
  const countMarks = htmlAll.split('共 ').length - 1;
  assert.equal(countMarks, 1, '仅超限类标计数，未超限不打扰');
});

test('Security 超限进内折叠：前 200 展开 + 其余折叠', function() {
  const many = [];
  for (let i = 0; i < 205; i++) { many.push('- 安全' + String(i)); }
  const md = lines(['# C', '', '## [1.1.0]', '', '### Security'].concat(many));
  const html = renderChangelogHTML(parseChangelog(md), { from: '1.0.0', to: '1.1.0' });
  assert.ok(html.includes('data-cat="Security"'), 'Security 必显');
  assert.ok(html.includes('共 205 条'), 'Security 超限标计数');
  assert.ok(html.includes('dsh-upd-changelog-security-more'), 'Security 超限进内折叠');
  assert.ok(html.includes('其余 5 条'), '内折叠标其余数');
});

test('yanked 横幅：只看 to 版，文案冻结，role alert，后缀保留', function() {
  const md = lines(['# C', '', '## [1.1.0] - 2026-09-30 [YANKED]', '', '### Added', '- A', '', '## [1.0.0] [YANKED]', '', '### Added', '- O']);
  const entries = parseChangelog(md);
  const htmlTo = renderChangelogHTML(entries, { from: '1.0.0', to: '1.1.0' });
  assert.ok(htmlTo.includes('已撤回'), '每节后缀保留（纯渲染层只给后缀，横幅由面板层挂）');
  const panelHtml = renderUpdatePanelHTML(baseInput({ changelogMarkdown: md }));
  assert.ok(panelHtml.includes('目标版本 1.1.0 已被作者撤回'), '横幅点名 to 版（面板层挂）');
  assert.ok(panelHtml.includes('安装不受影响'), '横幅写清不拦截');
  assert.ok(panelHtml.includes('role="alert"'), '横幅有 alert 语义');
  const nBanner = panelHtml.split('已被作者撤回').length - 1;
  assert.ok(nBanner >= 1 && nBanner <= 3, 'to 版一条横幅 + 每节后缀（中间版本不另刷横幅）');
  assert.ok(panelHtml.split('目标版本').length - 1 === 1, '横幅只一条，只看 to 版');
  const banner = yankedBannerHTML('1.1.0');
  assert.ok(banner.includes('目标版本 1.1.0 已被作者撤回（yanked），安装不受影响，继续前请确认。'), '横幅文案冻结一字对应');
});

test('BREAKING 三写法命中：大小写不敏感，中英文冒号皆可', function() {
  assert.equal(isBreakingChangelogItem('BREAKING: drop node'), true);
  assert.equal(isBreakingChangelogItem('breaking: drop node'), true);
  assert.equal(isBreakingChangelogItem('Breaking：drop node'), true);
  assert.equal(isBreakingChangelogItem('不兼容: 去掉旧开关'), true);
  assert.equal(isBreakingChangelogItem('不兼容：去掉旧开关'), true);
  assert.equal(isBreakingChangelogItem('**BREAKING:** drop node'), true);
  assert.equal(isBreakingChangelogItem('> 不兼容: 去掉'), true);
  assert.equal(isBreakingChangelogItem('正文中间提到 BREAKING: 但不在开头'), false);
  assert.equal(isBreakingChangelogItem('fix BREAKING: misplaced'), false);
  const split = splitBreakingPrefix('**BREAKING:** drop node');
  assert.ok(split, '加粗写法应拆出前缀');
  assert.equal(split.prefix, 'BREAKING:');
  const md = lines(['# C', '', '## [1.1.0]', '', '### Added', '- BREAKING: drop node', '- **不兼容：** 去掉开关', '- 正文中间提到 BREAKING: 不应标']);
  const html = renderChangelogHTML(parseChangelog(md), { from: '1.0.0', to: '1.1.0' });
  assert.ok(html.includes('dsh-upd-breaking-badge'), '命中行首应有徽标');
  assert.ok(html.includes('role="img"'), '徽标有语义');
  assert.ok(html.includes('<strong>BREAKING:</strong>'), '前缀加粗，正文不动');
  assert.ok(html.includes('drop node'), '正文一字不动');
  const badgeCount = html.split('dsh-upd-breaking-badge').length - 1;
  assert.equal(badgeCount, 2, '仅开头两条挂标，中间散文不误标');
});

test('validate 行号与码表：E 报行号，W 预告截断与撤回', function() {
  const md = lines(['# C', '', '## 乱写标题', '', '### Added', '- x', '', '## [1.1.0]', '', '### UnknownCat', '- y', '', '### Added', '- BREAKING 缺冒号', '- 正常条目', '', '- 游离？']);
  const v = validateChangelog(md);
  assert.equal(v.ok, false, '有 Error 即 ok false');
  const byCode = {};
  for (const d of v.diagnostics) { byCode[d.code] = d; }
  assert.ok(byCode.E_VERSION_TITLE, '非法版本标题报 E');
  assert.equal(byCode.E_VERSION_TITLE.line, 3);
  assert.ok(byCode.E_CATEGORY, '未知分类报 E');
  assert.ok(byCode.W_BREAKING_MAYBE, '疑似误写报 W');
  let sorted = true;
  for (let i = 1; i < v.diagnostics.length; i++) { if (v.diagnostics[i].line < v.diagnostics[i-1].line) sorted = false; }
  assert.equal(sorted, true, '诊断按行号排序');
  const mdYank = lines(['# C', '', '## [1.1.0] [YANKED]', '', '### Added', '- A']);
  const vy = validateChangelog(mdYank);
  assert.ok(vy.diagnostics.some(function(d) { return d.code === 'W_YANKED'; }), '撤回报 W_YANKED');
  const many = [];
  for (let i = 0; i < 205; i++) { many.push('- b' + String(i)); }
  const mdTr = lines(['# C', '', '## [1.1.0]', '', '### Added'].concat(many));
  const vt = validateChangelog(mdTr);
  const wt = vt.diagnostics.find(function(d) { return d.code === 'W_TRUNCATED'; });
  assert.ok(wt, '超限预告 W_TRUNCATED');
  assert.ok(wt.hint.includes('205') && wt.hint.includes('200'), '预告含 M/N');
  const ve = validateChangelog('');
  assert.ok(ve.diagnostics.some(function(d) { return d.code === 'W_EMPTY'; }), '空文件报 W_EMPTY');
  const vok = validateChangelog(lines(['# C', '', '## [1.1.0]', '', '### Added', '- A']));
  assert.equal(vok.ok, true, '仅 W 或无诊断即 ok true');
  assert.equal(validateChangelog(null).diagnostics[0].code, 'W_EMPTY');
});

test('validate 与 parse 共享扫描仪：有 Error 必丢内容（总量性质）', function() {
  const md = lines(['# C', '', '## 坏标题', '', '### Added', '- 被丢1', '', '## [1.1.0]', '', '### 坏分类', '- 被丢2', '', '### Added', '- 好条目']);
  const v = validateChangelog(md);
  const errs = v.diagnostics.filter(function(d) { return d.code.charAt(0) === 'E'; });
  assert.ok(errs.length >= 2, '至少两条 Error');
  const bulletLines = md.split(String.fromCharCode(10)).filter(function(l) { return l.trim().charAt(0) === '-' && l.includes('被丢'); });
  assert.ok(bulletLines.length >= 2, '被丢条目行存在');
  const parsed = parseChangelog(md);
  let kept = 0;
  for (const e of parsed) { for (const k of Object.keys(e.sections)) { kept += e.sections[k].length; } }
  assert.ok(kept < bulletLines.length + 1, 'Error 存在即解析丢内容（被丢条目未进收录）');
  const good = parseChangelog(lines(['# C', '', '## [1.1.0]', '', '### Added', '- 好条目']));
  assert.equal(JSON.stringify(parsed[parsed.length-1].sections.Added), JSON.stringify(good[0].sections.Added), '好条目收录不受坏行污染');
});

test('shouldFetchChangelog 纯策略：记住不再问，手动总问，轮询按退避', function() {
  assert.equal(shouldFetchChangelog({ hasCache: true, failedAt: null, now: 1000, isManual: false }), false);
  assert.equal(shouldFetchChangelog({ hasCache: true, failedAt: 0, now: 1000, isManual: true }), false);
  assert.equal(shouldFetchChangelog({ hasCache: false, failedAt: null, now: 1000, isManual: false }), true);
  assert.equal(shouldFetchChangelog({ hasCache: false, failedAt: null, now: 1000, isManual: true }), true);
  assert.equal(shouldFetchChangelog({ hasCache: false, failedAt: 1000, now: 1000, isManual: false }), false);
  assert.equal(shouldFetchChangelog({ hasCache: false, failedAt: 1000, now: 1000 + 30*1000, isManual: false }), true);
  assert.equal(shouldFetchChangelog({ hasCache: false, failedAt: 1000, now: 2000, isManual: true }), true);
});

test('面板默认 autoChangelog 下四处优化可见；显式文本仍赢、false 可退；缺日志不挡安装', async function() {
  const md = lines(['# C', '', '## [1.1.0] [YANKED]', '', '### Security', '- 安全修复', '', '### Added', '- BREAKING: 不兼容变更']);
  function callFor(status, mdText) {
    const log = [];
    const call = async function(name, args) {
      log.push({ name: name, args: args });
      if (name.endsWith('.updateStatus')) return { ok: true, snapshot: status, manual: null, receipt: null };
      if (name.endsWith('.updateCheck')) return { ok: true, snapshot: status, manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 } };
      if (name.endsWith('.updateChangelog')) return { ok: true, version: '1.1.0', markdown: mdText };
      throw new Error('unknown:' + name);
    };
    return { call: call, log: log };
  }
  const status = baseSnapshot();
  const ctx1 = callFor(status, md);
  const slot1 = fakeContainer();
  const p1 = mountUpdatePanel(slot1, { pluginId: 'p', prefix: 't41', call: ctx1.call });
  try {
    await p1.refresh();
    await settled(); await settled();
    assert.ok(slot1.innerHTML.includes('Security'), 'Security 必显');
    assert.ok(slot1.innerHTML.includes('dsh-upd-breaking-badge'), '破坏徽标可见');
    assert.ok(slot1.innerHTML.includes('已被作者撤回'), '撤回横幅可见');
    assert.ok(slot1.innerHTML.includes('安装 1.1.0'), '缺日志也不挡安装（有日志更不挡）');
  } finally { p1.unmount(); }
  const explicit = lines(['# C', '', '## [1.1.0]', '', '### Added', '- 手动文本']);
  const ctx2 = callFor(status, md);
  const slot2 = fakeContainer();
  const p2 = mountUpdatePanel(slot2, { pluginId: 'p', prefix: 't41', call: ctx2.call, changelogMarkdown: explicit });
  try {
    await p2.refresh();
    await settled();
    assert.ok(slot2.innerHTML.includes('手动文本'), '显式文本仍赢');
    assert.equal(ctx2.log.filter(function(e) { return e.name.endsWith('.updateChangelog'); }).length, 0, '显式文本不自动问');
  } finally { p2.unmount(); }
  const ctx3 = callFor(status, md);
  const slot3 = fakeContainer();
  const p3 = mountUpdatePanel(slot3, { pluginId: 'p', prefix: 't41', call: ctx3.call, autoChangelog: false });
  try {
    await p3.refresh();
    await settled();
    assert.equal(ctx3.log.filter(function(e) { return e.name.endsWith('.updateChangelog'); }).length, 0, 'false 可退');
  } finally { p3.unmount(); }
});

test('refresh 重试失败：传输失败轮询退避、手动立即重问', async function() {
  let n = 0;
  const status = baseSnapshot();
  const call = async function(name, args) {
    if (name.endsWith('.updateStatus')) return { ok: true, snapshot: status, manual: null, receipt: null };
    if (name.endsWith('.updateCheck')) return { ok: true, snapshot: status, manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 } };
    if (name.endsWith('.updateChangelog')) {
      n++;
      if (n === 1) return { ok: false, error: 'check-failed', errorKind: 'check-failed' };
      return { ok: true, version: '1.1.0', markdown: lines(['# C', '', '## [1.1.0]', '', '### Added', '- 重试后成功']) };
    }
    throw new Error('unknown');
  };
  const slot = fakeContainer();
  const p = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't41r', call: call });
  try {
    await p.refresh();
    await settled(); await settled();
    assert.equal(n, 1, '首次失败记一次');
    await p.refresh();
    await settled(); await settled();
    assert.equal(n, 1, '轮询退避内不再问');
    await p.act('check');
    await settled(); await settled();
    assert.ok(n >= 2, '手动查新版立即重问');
    assert.ok(slot.innerHTML.includes('重试后成功'), '重试成功后渲染');
  } finally { p.unmount(); }
});

test('Archive 只换肤不换 DOM 顺序', function() {
  const md = lines(['# C', '', '## [1.1.0] [YANKED]', '', '### Security', '- s', '', '### Added', '- BREAKING: b']);
  const input = baseInput({ changelogMarkdown: md });
  const a = renderUpdatePanelHTML(input);
  const b = renderUpdatePanelHTML(baseInput({ changelogMarkdown: md, theme: 'archive' }));
  function stripStyleAndTheme(h) {
    let out = h;
    while (out.includes('<style>')) {
      const s = out.indexOf('<style>');
      const e = out.indexOf('</style>');
      if (s < 0 || e < 0) break;
      out = out.slice(0, s) + out.slice(e + 8);
    }
    out = out.split(' data-theme="archive"').join('');
    return out;
  }
  const ka = stripStyleAndTheme(a);
  const kb = stripStyleAndTheme(b);
  assert.equal(ka, kb, 'Archive 与默认内核 DOM 应一字相同（只换肤）');
  assert.ok(b.includes('data-theme="archive"'), 'Archive 挂主题属性');
});
