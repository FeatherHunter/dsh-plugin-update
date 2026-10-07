/**
 * tests/issue-83-rows-consistency.test.mjs —— #83 明细行版本与对齐：复核#71+单/入口一致性。
 *
 * 缝：batchRowVersionParts / batchRowPendingStatus / renderBatchPanelHTML / batchLedgerCounts
 *     / batchEntrySummary（入口聚合）/ 单面板 versionStrip+banner / 单入口 entryLabelFor。
 * 只测外部行为/产物，不碰实现细节；文案只认字典已有键（bilingual零新增）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_BATCH_PANEL_CSS,
  batchLedgerCounts,
  batchRowPendingStatus,
  batchRowVersionParts,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js';
import { batchEntrySummary, batchEntryLabelFor, mountUpdateBatchEntry } from '../dist/entry-batch.js';
import { entryLabelFor } from '../dist/entry.js';
import { renderUpdatePanelHTML } from '../dist/panel.js';

function snap(v, extra = {}) {
  return { runningVersion: v, installedVersion: v, latestVersion: v, canInstall: true, blockedReason: null, job: null, ...extra };
}
function rowOf(o = {}) {
  return { key: 'a', title: '甲', phase: 'pending', targetVersion: null, restartRequired: false, error: null, snapshot: null, manual: null, queue: null, profileName: null, ...o };
}
function emptySession() {
  return { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 };
}
function invOf(entries) { return { version: 1, updatedAt: 1, entries }; }

// ---------- 复核 #71（69befa8）无回归：三问各一条 tracer ----------

describe('#83复核#71无回归', () => {
  it('Q2三列网格左起点一致：grid+18ch+nowrap+状态同列起', () => {
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('dsh-upd-brow-main{display:grid'), '三列网格');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('minmax(18ch,max-content)'), '版本列定宽18ch');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('white-space:nowrap'), '版本nowrap');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('minmax(0,1fr)'), '状态列1fr');
  });
  it('Q3会话优先知识仅展示：会话目标赢知识', () => {
    const s = snap('0.3.42');
    assert.deepEqual(
      batchRowVersionParts(rowOf({ phase: 'ready', targetVersion: '9.9.9', snapshot: s }), { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null }),
      { current: '0.3.42', latest: '9.9.9', hasUpdate: true },
    );
  });
  it('Q3四态：无知识回还没查过且仍显当前版', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.42') })], session: emptySession(), lang: 'zh' });
    assert.ok(html.includes('还没查过'), '无知识四态之还没查过');
    assert.ok(html.includes('dsh-upd-bver">0.3.42'), '永远显示当前版');
    assert.equal(batchRowPendingStatus(rowOf({ phase: 'ready' }), null, 'zh'), null, '非pending回null');
  });
});

// ---------- 单/入口行一致性结论（只读对照：三列/箭头红仅批量行） ----------

describe('#83单/入口一致性（只读对照）', () => {
  it('单面板版本条三格恒在：运行/磁盘/远端各一格，恒显当前，无批量箭头红', () => {
    const html = renderUpdatePanelHTML({ pluginId: 'p', snapshot: snap('1.0.0', { latestVersion: '1.2.0' }) });
    assert.ok(html.includes('dsh-upd-strip'), '单面板版本条三格');
    assert.ok(html.includes('1.0.0'), '恒显当前运行版');
    assert.ok(html.includes('1.2.0'), '远端版同条展示');
    assert.ok(!html.includes('dsh-upd-bver-new'), '单面板不套批量行红（不同表面，N/A）');
  });
  it('单入口文案只说最新版：有新版带latest，无三列概念', () => {
    const label = entryLabelFor({ snapshot: snap('1.0.0', { latestVersion: '1.2.0' }), error: null }, 'zh');
    assert.ok(label.includes('1.2.0'), '单入口说最新版号');
  });
});

// ---------- 残留高优（红→绿）：两处版本/聚合与状态列互斥 ----------

describe('#83残留高优', () => {
  it('知识孤版（快照无当前+知识仅latest）：版本列须?→latest红，与状态列有新版一致', () => {
    const row = rowOf({ phase: 'pending', snapshot: null });
    const know = { lastCheckedAt: 1, installedVersion: null, latestVersion: '2.0.0', canInstall: true, error: null };
    const parts = batchRowVersionParts(row, know);
    assert.deepEqual(parts, { current: null, latest: '2.0.0', hasUpdate: true }, '孤版按会话缺当前同例：?=占位+红');
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'pending', snapshot: null })], session: emptySession(), inventory: invOf({ a: know }), lang: 'zh' });
    assert.ok(html.includes('dsh-upd-bver-new">2.0.0'), '版本列红与状态列同口径');
    assert.ok(html.includes('有新版 2.0.0'), '状态列有新版');
  });
  it('批量入口聚合吃知识：pending+知识有新版即N家可更新，与面板总账同口径', () => {
    const rows = [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.42') }), rowOf({ key: 'b', phase: 'pending', snapshot: snap('0.3.42') })];
    const inventory = invOf({
      a: { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null },
      b: { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null },
    });
    const panelCounts = batchLedgerCounts(rows, inventory);
    assert.equal(panelCounts.updatable, 2, '面板总账对照：知识有新版进可更新');
    const s = batchEntrySummary({ rows, error: null, inventory }, 'zh');
    assert.equal(s.updatable, 2, '入口聚合与面板总账同一份数法');
    assert.equal(s.kind, 'update', '档位同为update');
    assert.equal(batchEntryLabelFor({ rows, error: null, inventory }, 'zh'), '2 家可更新', '文案同为N家可更新');
  });
  it('批量入口挂载透传知识：batchStatus回包inventory即进聚合（只读透传）', async () => {
    const rows = [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.42') })];
    const inventory = invOf({ a: { lastCheckedAt: 1, installedVersion: '0.3.42', latestVersion: '0.3.44', canInstall: true, error: null } });
    const call = async (name) => {
      if (String(name).endsWith('.batchStatus')) return { ok: true, session: { id: 's' }, rows, progress: null, inventory };
      throw new Error('unknown-phone:' + name);
    };
    const box = { innerHTML: '', addEventListener() {}, removeEventListener() {} };
    const entry = mountUpdateBatchEntry(box, { prefix: 'life', call, pollMs: 60000 });
    await new Promise((r) => setTimeout(r, 20));
    const s = entry.summary();
    assert.equal(s.updatable, 1, '挂载后聚合即知识口径');
    assert.equal(s.kind, 'update', '按钮档位同面板总账');
    entry.unmount();
  });
  it('批量入口无知识零回归：不传inventory即旧语义pending', () => {
    const rows = [rowOf({ key: 'a', phase: 'pending', snapshot: snap('0.3.42') })];
    const s = batchEntrySummary({ rows, error: null }, 'zh');
    assert.equal(s.kind, 'idle', '无知识仍idle（旧语义）');
    assert.equal(s.pending, 1, 'pending计数保留');
  });
});
