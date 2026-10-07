/**
 * tests/issue-71-batch-rows.test.mjs —— #71 批量行三列对齐 + pending 显示最新版 + 新版红。
 *
 * 只测外部行为/产物：版本列三段式（只红新版）、pending 知识版、无知识四态、
 * 三列网格 CSS 约束、专用红 token 深浅主题。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_BATCH_PANEL_CSS,
  UPDATE_BATCH_PANEL_ARCHIVE_CSS,
  batchRowPendingStatus,
  batchRowVersionParts,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js'
import { themeTokensStyleFor } from '../dist/panel.js'

function snap(v, extra = {}) {
  return { runningVersion: v, installedVersion: v, latestVersion: v, canInstall: true, blockedReason: null, job: null, ...extra }
}
function rowOf(o = {}) {
  return { key: 'a', title: '甲', phase: 'pending', targetVersion: null, restartRequired: false, error: null, snapshot: null, manual: null, queue: null, profileName: null, ...o }
}
function emptySession() {
  return { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 }
}
function rowMainOf(html, key) {
  const at = html.indexOf('data-key="' + key + '"')
  assert.ok(at >= 0, key + ' 行要有')
  const mainAt = html.indexOf('dsh-upd-brow-main', at)
  return html.slice(mainAt, mainAt + 1400)
}

describe('#71 Q1：只红新版本号', () => {
  it('未装行三段式走红：老版本弱化、箭头中性、新版红加粗', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'ready', targetVersion: '0.3.44', snapshot: snap('0.3.42') })], lang: 'zh' })
    const main = rowMainOf(html, 'a')
    assert.ok(main.includes('dsh-upd-bver-cur">0.3.42'), '老版本段')
    assert.ok(main.includes('dsh-upd-bver-arrow'), '箭头段保留')
    assert.ok(main.includes('dsh-upd-bver-new">0.3.44'), '新版本段')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bver-new{color:var(--dsh-update-new-text'), '新版走专用红 token')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bver-new') && UPDATE_BATCH_PANEL_CSS.includes('font-weight:700'), '红为第二信号：加粗保留')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bver-cur{opacity:'), '老版本弱化')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bver-arrow{opacity:'), '箭头中性')
  })

  it('装好行走绿：done 的新版用 new-ok 段', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'done', targetVersion: '0.3.44', restartRequired: true, snapshot: snap('0.3.42') })], lang: 'zh' })
    const main = rowMainOf(html, 'a')
    assert.ok(main.includes('dsh-upd-bver-new-ok\">0.3.44'), '装好走绿')
    assert.ok(!main.includes('dsh-upd-bver-new\">'), '装好不行红段')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bver-new-ok{color:var(--dsh-update-new-ok-text'), '绿走专用 token')
  })

  it('装中/待装行走红：installing 与 ready 的新版用 new 段', () => {
    for (const phase of ['ready', 'installing']) {
      const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase, targetVersion: '0.3.44', snapshot: snap('0.3.42') })], lang: 'zh' })
      const main = rowMainOf(html, 'a')
      assert.ok(main.includes('dsh-upd-bver-new\">0.3.44'), phase + ' 走红')
      assert.ok(!main.includes('new-ok'), phase + ' 不走绿')
    }
  })

  it('无新版行不变红：只显当前，无 new 段', () => {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.44') })],
      session: emptySession(),
      inventory: { version: 1, updatedAt: 1, entries: { a: { lastCheckedAt: 1, installedVersion: '0.3.44', latestVersion: '0.3.44', canInstall: true, error: null } } },
      lang: 'zh',
    })
    const main = rowMainOf(html, 'a')
    assert.ok(main.includes('dsh-upd-bver">0.3.44'), '只显当前版')
    assert.ok(!main.includes('dsh-upd-bver-new'), '无新版不变红')
    assert.ok(main.includes('已是最新'), '状态词保留，非颜色信号')
  })

  it('专用红 token 深浅主题可读 + forced-colors 回退', () => {
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-batch{--dsh-update-new-text:#dc2626}'), '浅色默认红')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('@media (prefers-color-scheme: dark){.dsh-upd-batch{--dsh-update-new-text:#f87171}}'), '深色提亮')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('@media (forced-colors: active){.dsh-upd-bver-new{color:CanvasText}}'), '高对比回退，箭头加粗状态词仍在')
    assert.ok(String(UPDATE_BATCH_PANEL_ARCHIVE_CSS).includes('--dsh-update-new-text:#b3261e'), '档案浅色')
    assert.ok(String(UPDATE_BATCH_PANEL_ARCHIVE_CSS).includes('--dsh-update-new-text:#ef8a7d'), '档案深色')
    assert.equal(themeTokensStyleFor({ newText: '#c8402a' }), '--dsh-update-new-text:#c8402a', '第三方可覆专用红')
    assert.equal(themeTokensStyleFor({ newOkText: '#1a7f37' }), '--dsh-update-new-ok-text:#1a7f37', '第三方可覆专用绿')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bver-new-ok{color:var(--dsh-update-new-ok-text'), '绿段样式在')
    assert.ok(String(UPDATE_BATCH_PANEL_ARCHIVE_CSS).includes('--dsh-update-new-ok-text:#1a7f37'), '档案绿浅色')
  })
})

describe('#71 Q2：三列网格左起点一致', () => {
  it('行主区网格 + 版本列定宽 + 状态换行仍同列起', () => {
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('dsh-upd-brow-main{display:grid'), '三列网格')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('grid-template-columns:'), '列起点由网格定')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('minmax(18ch,max-content)'), '版本列定宽 18ch')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('font-variant-numeric:tabular-nums'), '等宽数字')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bver{') && UPDATE_BATCH_PANEL_CSS.includes('white-space:nowrap'), '版本 nowrap')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('minmax(0,1fr)'), '状态列自适应')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bstat{') && UPDATE_BATCH_PANEL_CSS.includes('overflow-wrap:anywhere'), '窄屏状态折行仍从状态列起')
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-bfail{grid-column:1/-1'), '错误行跨整行，不挤列')
  })

  it('7 行同宽下版本长度不推动状态：3 行 → + 4 行 pending 状态同列', () => {
    const rows = [
      rowOf({ key: 'k1', title: '饼干记账', phase: 'done', targetVersion: '0.3.44', restartRequired: true, snapshot: snap('0.3.42') }),
      rowOf({ key: 'k2', title: '卡路里', phase: 'done', targetVersion: '0.3.44', restartRequired: true, snapshot: snap('0.3.42') }),
      rowOf({ key: 'k3', title: '备忘录', phase: 'installing', targetVersion: '0.3.44', snapshot: snap('0.3.42') }),
      rowOf({ key: 'k4', title: '作息管家', phase: 'pending', snapshot: snap('0.3.42') }),
      rowOf({ key: 'k5', title: '居家管家', phase: 'pending', snapshot: snap('0.3.42') }),
      rowOf({ key: 'k6', title: '私家大厨', phase: 'pending', snapshot: snap('0.3.42') }),
      rowOf({ key: 'k7', title: '爱生活', phase: 'pending', snapshot: snap('0.3.42') }),
    ]
    const inventory = { version: 1, updatedAt: 1, entries: {} }
    for (const k of ['k4', 'k5', 'k6', 'k7']) inventory.entries[k] = { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null }
    const html = renderBatchPanelHTML({ rows, session: emptySession(), inventory, lang: 'zh' })
    for (const k of ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']) {
      const main = rowMainOf(html, k)
      assert.ok(main.includes('dsh-upd-bname'), k + ' 有名列')
      assert.ok(main.includes('dsh-upd-bver'), k + ' 有版本列')
      assert.ok(main.includes('dsh-upd-bstat'), k + ' 有状态列')
      if (k === 'k1' || k === 'k2') assert.ok(main.includes('dsh-upd-bver-new-ok'), k + ' 装好走绿')
      else assert.ok(main.includes('dsh-upd-bver-new">') && !main.includes('new-ok'), k + ' 未装走红')
    }
  })
})

describe('#71 Q3：永远显示当前版 + 四态', () => {
  it('batchRowVersionParts：会话优先，知识只做展示', () => {
    const s = snap('0.3.42')
    assert.deepEqual(batchRowVersionParts(rowOf({ phase: 'ready', targetVersion: '0.3.44', snapshot: s }), null), { current: '0.3.42', latest: '0.3.44', hasUpdate: true })
    assert.deepEqual(
      batchRowVersionParts(rowOf({ phase: 'pending', snapshot: s }), { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null }),
      { current: '0.3.42', latest: '0.3.44', hasUpdate: true },
    )
    assert.deepEqual(
      batchRowVersionParts(rowOf({ phase: 'pending', snapshot: snap('0.3.44') }), { lastCheckedAt: 1, installedVersion: '0.3.44', latestVersion: '0.3.44', canInstall: true, error: null }),
      { current: '0.3.44', latest: null, hasUpdate: false },
    )
    assert.deepEqual(batchRowVersionParts(rowOf({ phase: 'pending', snapshot: s }), null), { current: '0.3.42', latest: null, hasUpdate: false })
    // 会话目标与知识同时有时会话赢（安装语义不动）
    assert.deepEqual(
      batchRowVersionParts(rowOf({ phase: 'ready', targetVersion: '9.9.9', snapshot: s }), { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null }),
      { current: '0.3.42', latest: '9.9.9', hasUpdate: true },
    )
    // 快照缺失退知识 installedVersion；皆无回空
    assert.deepEqual(
      batchRowVersionParts(rowOf({ phase: 'pending', snapshot: null }), { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null }),
      { current: '0.3.42', latest: '0.3.44', hasUpdate: true },
    )
    assert.deepEqual(batchRowVersionParts(rowOf({ phase: 'pending', snapshot: null }), null), { current: null, latest: null, hasUpdate: false })
  })

  it('四态状态词：有新版 / 已是最新 / 还没查过 / 查失败；失败红只给错误行', () => {
    const upd = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.42') })], session: emptySession(), inventory: { version: 1, updatedAt: 1, entries: { a: { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null } } }, lang: 'zh' })
    assert.ok(upd.includes('有新版 0.3.44') && !upd.includes('等它，轮到就自动查新版'), '有新版不再 wait-turn')
    const cur = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.44') })], session: emptySession(), inventory: { version: 1, updatedAt: 1, entries: { a: { lastCheckedAt: 1, installedVersion: '0.3.44', latestVersion: '0.3.44', canInstall: true, error: null } } }, lang: 'zh' })
    assert.ok(cur.includes('已是最新'), '已是最新')
    const never = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.42') })], session: emptySession(), lang: 'zh' })
    assert.ok(never.includes('还没查过') && !never.includes('等它，轮到就自动查新版'), '无知识回还没查过，不再误 wait-turn')
    assert.ok(rowMainOf(never, 'a').includes('dsh-upd-bver">0.3.42'), '无知识仍显示当前版')
    const failedKnow = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.42') })], session: emptySession(), inventory: { version: 1, updatedAt: 1, entries: { a: { lastCheckedAt: 1, installedVersion: null, latestVersion: null, canInstall: null, error: 'check-failed' } } }, lang: 'zh' })
    assert.ok(failedKnow.includes('这次没查到'), '查失败中性文案')
    assert.ok(!rowMainOf(failedKnow, 'a').includes('dsh-upd-bver-new'), '查失败版本不变红')
    assert.ok(!rowMainOf(failedKnow, 'a').includes('dsh-upd-bfail'), '知识查失败不画错误红行')
    const failedRow = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'failed', error: 'install-failed', snapshot: snap('0.3.42') })], lang: 'zh' })
    assert.ok(rowMainOf(failedRow, 'a').includes('dsh-upd-bfail'), '失败红只给错误行')
  })

  it('batchRowPendingStatus：非 pending 回 null；pending 无知识回还没查过', () => {
    assert.equal(batchRowPendingStatus(rowOf({ phase: 'ready' }), null, 'zh'), null)
    assert.equal(batchRowPendingStatus(rowOf({ phase: 'pending' }), null, 'zh'), '还没查过')
    assert.ok((batchRowPendingStatus(rowOf({ phase: 'pending' }), { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null }, 'zh') || '').includes('0.3.44'))
  })

  it('有轮次未做完仍走执行态：知识不顶掉 wait-turn', () => {
    const session = { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: ['a'], entries: [{ key: 'a', phase: 'pending', requestId: 'r', targetVersion: null, restartRequired: false, error: null, updatedAt: 0 }], createdAt: 0, updatedAt: 0 }
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'pending', snapshot: snap('1.0.0') })], session, inventory: { version: 1, updatedAt: 1, entries: { a: { lastCheckedAt: 1, installedVersion: '1.0.0', latestVersion: '2.0.0', canInstall: true, error: null } } }, lang: 'zh' })
    assert.ok(html.includes('等它，轮到就自动查新版'), '轮次中仍 wait-turn')
    assert.ok(html.includes('上一批没做完'), '轮次标记保留')
    assert.ok(!rowMainOf(html, 'a').includes('dsh-upd-bver-new'), '轮次中版本不提前 →，只显当前')
  })
})
