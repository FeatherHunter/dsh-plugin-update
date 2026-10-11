/**
 * tests/batch-archive-prototype-align.test.mjs —— 批量面板对齐档案原型（接着 #102 单面板三件套）。
 *
 * 只测外部行为/产物：
 *  ① 批量宏按钮（检查更新/全部更新）与行内按钮（详情/请重启DSH）照原型收紧：
 *     宏 13px、无最小宽、8px 间距；行内与详情小按钮 12px；
 *  ② 黄框副行出框：restart-action 住框外 `.dsh-upd-banner-sub`，失败档同理；
 *  ③ 黄框名单居左、按钮同行居右：名单与按钮同处 `.dsh-upd-browline` 一行，按钮在名单之后；
 *  ④ 单面板收起/展开日志开关（`.dsh-upd-chap-note button`）同为档案小按钮。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_BATCH_PANEL_CSS,
  UPDATE_BATCH_PANEL_ARCHIVE_CSS,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js'
import { UPDATE_PANEL_ARCHIVE_CSS, renderUpdatePanelHTML } from '../dist/panel.js'

function snapshotOf(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.2.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function rowOf(overrides = {}) {
  return {
    key: 'a',
    title: '甲插件',
    phase: 'ready',
    targetVersion: '1.2.0',
    restartRequired: false,
    error: null,
    snapshot: snapshotOf(),
    manual: null,
    queue: null,
    profileName: null,
    ...overrides,
  }
}

function domOf(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/, '')
}

describe('批量宏与行内按钮贴原型', () => {
  it('宏按钮紧凑：13px、无最小宽、8px 间距、非主透明底', () => {
    const css = UPDATE_BATCH_PANEL_ARCHIVE_CSS
    assert.ok(css.includes('.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros{gap:8px}'), '宏行 8px 间距')
    assert.ok(
      css.includes('.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0}'),
      '宏按钮 13px 紧凑、无最小宽',
    )
    assert.ok(
      css.includes('.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button:not([data-primary="1"]){background:transparent}'),
      '非主按钮透明底（主按钮红底不动）',
    )
  })

  it('行内/详情/更多按钮小号 12px', () => {
    const css = UPDATE_BATCH_PANEL_ARCHIVE_CSS
    for (const sel of ['.dsh-upd-brow-actions button', '.dsh-upd-bdetail-actions button', '.dsh-upd-batch-more button']) {
      assert.ok(css.includes('.dsh-upd[data-theme="archive"] ' + sel + '{font-size:12px'), sel + ' 须 12px 小按钮')
    }
  })

  it('内核最小宽度预留还在（只收敛皮肤，不动预留）', () => {
    assert.ok(
      UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-batch-macros button:first-child,.dsh-upd-batch-macros button[data-primary="1"]{min-width:6em'),
      '内核宏按钮预留仍在',
    )
  })
})

describe('黄框副行出框 + 名单按钮同行', () => {
  const restartRows = () => [
    rowOf({ key: 'a', title: '甲插件', phase: 'done', restartRequired: true }),
    rowOf({ key: 'b', title: '乙插件', phase: 'done', restartRequired: true }),
  ]

  it('restart-action 住框外 sub，框内只剩标题与名单按钮行', () => {
    const dom = domOf(renderBatchPanelHTML({ rows: restartRows(), theme: 'archive', lang: 'zh' }))
    const bannerAt = dom.indexOf('<div class="dsh-upd-banner" data-kind="restart"')
    assert.ok(bannerAt >= 0, '须有待重启横幅')
    const bannerClose = dom.indexOf('</div>', dom.indexOf('dsh-upd-browline', bannerAt))
    const banner = dom.slice(bannerAt, bannerClose)
    assert.ok(!banner.includes('重启宿主以加载新版'), '行动句不许在框内')
    const subAt = dom.indexOf('<div class="dsh-upd-banner-sub">', bannerClose)
    assert.ok(subAt > bannerClose, '行动句须在框后兄弟 sub 内')
    assert.ok(dom.slice(subAt, subAt + 200).includes('重启宿主以加载新版本'), 'sub 内即该句')
  })

  it('名单与按钮同处一行内 flex 行：名单在前按钮在后', () => {
    const dom = domOf(renderBatchPanelHTML({ rows: restartRows(), theme: 'archive', lang: 'zh' }))
    const lineAt = dom.indexOf('<div class="dsh-upd-browline">')
    assert.ok(lineAt >= 0, '须有名单元行')
    const line = dom.slice(lineAt, dom.indexOf('</div>', lineAt) + 6)
    const listAt = line.indexOf('dsh-upd-blist')
    const btnAt = line.indexOf('data-act="restart"')
    assert.ok(listAt >= 0 && btnAt > listAt, '名单在前、按钮在后同一行')
    assert.ok(line.includes('甲插件') && line.includes('乙插件'), '名单即待重启两家')
  })

  it('名单行皮肤：拉满居左、按钮居右', () => {
    const css = UPDATE_BATCH_PANEL_ARCHIVE_CSS
    assert.ok(
      css.includes('.dsh-upd[data-theme="archive"] .dsh-upd-banner>.dsh-upd-browline{align-self:stretch;display:flex;'),
      '名单行须拉满（短行不被居中收窄）',
    )
    assert.ok(css.includes('.dsh-upd-blist{flex:1 1 auto;') && css.includes('text-align:left'), '名单居左占满')
    assert.ok(css.includes('.dsh-upd-browline button{flex:none;margin:0;margin-left:auto;'), '按钮居右不换行')
  })

  it('失败档副行同样出框（与单面板同口径）', () => {
    const dom = domOf(
      renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'failed', error: 'install-failed' })], lang: 'zh' }),
    )
    const bannerAt = dom.indexOf('<div class="dsh-upd-banner" data-kind="failed"')
    assert.ok(bannerAt >= 0, '须有失败横幅')
    const subAt = dom.indexOf('<div class="dsh-upd-banner-sub">')
    assert.ok(subAt > bannerAt, '失败行动句同样住框外')
  })
})

describe('单面板收起/展开开关同为档案小按钮', () => {
  it('chap-note 按钮 12px 小按钮（收起日志/队列开关同档）', () => {
    assert.ok(
      UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd[data-theme="archive"] .dsh-upd-chap-note button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0;background:transparent}'),
      '标题行开关须 12px 小按钮',
    )
  })

  it('有日志时开关仍在（只换肤，不藏开关）', () => {
    const html = renderUpdatePanelHTML({
      snapshot: { runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0', canInstall: true, blockedReason: null, job: null },
      manual: null,
      queue: { busy: false, owner: null, waiting: [], position: null },
      skippedLatest: false,
      lastError: null,
      changelogMarkdown: '## [1.1.0]\n\n### Added\n- A\n',
      showOthers: false,
      pluginId: 'p',
      copyNotice: null,
      mode: 'embedded',
      lang: 'zh',
      theme: 'archive',
      profileName: 'web',
      hostKind: 'cli',
    }, 'zh')
    const dom = html.replace(/<style>[\s\S]*?<\/style>/, '')
    assert.ok(dom.includes('data-action="toggle-changelog"'), '收起/展开开关仍在')
  })
})
