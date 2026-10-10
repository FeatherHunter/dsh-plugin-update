/**
 * tests/changelog-zh-honest.test.mjs —— 中文分类 + 诚实中性行。
 *
 * 只测外部行为：
 *  ① 中文分类是 BUG 修：`### 新增` 等六中文名与英文完全等价（精确匹配，不做子串，
 *     `### 新增功能` 仍是未知分类）；validate 同口径（共享扫描仪），E_CATEGORY 提示如实列出中英文；
 *  ② 诚实中性行是 BUG 修：有文本但零解析节 → "日志读不出来"（无标题），不再撒谎"作者未提供"；
 *     空文本仍"未提供"（零回归）；区间外旧行为不动。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseChangelog,
  validateChangelog,
  CHANGELOG_VALIDATE_HINTS,
} from '../dist/changelog.js'
import { renderUpdatePanelHTML } from '../dist/panel.js'

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0',
    canInstall: true, blockedReason: null, job: null,
    ...overrides,
  }
}

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
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
    ...viewOverrides,
    ...renderOverrides,
  }
}

const ZH_MD = [
  '# Changelog', '',
  '## [1.1.0] - 2026-10-02', '',
  '### 新增', '- 一键复制诊断信息', '',
  '### 修复', '- 安装完成状态判定', '',
  '### 变更', '- 文案微调', '',
  '### 弃用预告', '- 旧参数', '',
  '### 移除', '- 旧开关', '',
  '### 安全', '- 收紧校验', '',
].join('\n')

describe('中文分类与英文等价', () => {
  test('六中文名各进各的类', () => {
    const e = parseChangelog(ZH_MD)[0]
    assert.ok(e, '应解析出一节')
    assert.deepEqual(e.sections.Added, ['一键复制诊断信息'])
    assert.deepEqual(e.sections.Fixed, ['安装完成状态判定'])
    assert.deepEqual(e.sections.Changed, ['文案微调'])
    assert.deepEqual(e.sections.Deprecated, ['旧参数'])
    assert.deepEqual(e.sections.Removed, ['旧开关'])
    assert.deepEqual(e.sections.Security, ['收紧校验'])
    assert.equal(e.date, '2026-10-02', '日期照收')
  })

  test('子串不算：`### 新增功能` 仍是未知分类', () => {
    const md = '## [1.1.0]\n\n### 新增功能\n- x\n'
    assert.deepEqual(parseChangelog(md), [], '整节无可见内容即丢弃')
    const v = validateChangelog(md)
    assert.ok(v.diagnostics.some((d) => d.code === 'E_CATEGORY'), '仍报 E_CATEGORY')
  })

  test('validate 对中文全绿，E 提示如实列出中英文', () => {
    const v = validateChangelog(ZH_MD)
    assert.equal(v.ok, true, '中文合规即 ok')
    assert.ok(!v.diagnostics.some((d) => d.code === 'E_CATEGORY'), '中文名不再报 E')
    assert.ok(CHANGELOG_VALIDATE_HINTS.E_CATEGORY.includes('新增'), 'E 提示须列中文名')
    assert.ok(CHANGELOG_VALIDATE_HINTS.E_CATEGORY.includes('Added'), 'E 提示仍列英文名')
  })

  test('面板照画中文节内容', () => {
    const html = renderUpdatePanelHTML(inputFor({ changelogMarkdown: ZH_MD }))
    assert.ok(html.includes('一键复制诊断信息'), '中文节内容进面板')
    assert.ok(html.includes('新增（Added）'), '分类头照出')
  })
})

describe('诚实中性行：有文零解析即读不出来', () => {
  test('乱文本 → "读不出来"，不再"未提供"，且无区间标题', () => {
    const html = renderUpdatePanelHTML(inputFor({ changelogMarkdown: '## 乱写标题\n- 游离条目\n' }))
    assert.ok(html.includes('日志读不出来'), '须诚实说读不出来')
    assert.ok(!html.includes('作者未提供'), '不许再撒谎未提供')
    assert.ok(!html.includes('更新说明（'), '无内容即无区间标题')
  })

  test('空文本 → 仍"未提供"（零回归）', () => {
    for (const md of [null, '', '   ']) {
      const html = renderUpdatePanelHTML(inputFor({ changelogMarkdown: md }))
      assert.ok(html.includes('作者未提供更新说明'), JSON.stringify(md) + ' 须仍是未提供')
    }
  })

  test('中文坏分类同样走读不出来（与英文同口径）', () => {
    const html = renderUpdatePanelHTML(inputFor({ changelogMarkdown: '## [1.1.0]\n\n### 坏分类\n- y\n' }))
    assert.ok(html.includes('日志读不出来'), '坏分类即零解析节')
  })
})
