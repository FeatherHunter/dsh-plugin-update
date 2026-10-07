/**
 * tests/issue-88-single-entry.test.mjs —— #88 单面板+入口一致性：详情复用内核与聚合按钮同口径。
 *
 * 对照表先行（见探索笔记 88-*.md）：单面板 查/装/changelog/跳过/diag 三处对照
 * （单面板 vs 批量详情 vs 入口），批量 dialog 关闭（#50）无回归锁，批量入口聚合
 * （#49）与语言跟随（#51，只引用不抢终裁）无冲突锁，死按钮摘净锁。
 *
 * 只测外部行为/产物，不碰实现细节；文案只认字典已有键（bilingual 零新增）。
 * 高优红：详情 row-skip 非法版本与单面板 skip 不同口径（单面板静默不记，
 * 详情却 toast“已跳过”撒谎）；其余为同口径绿锁。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountUpdatePanel,
  renderUpdatePanelHTML,
} from '../dist/panel.js';
import {
  mountUpdateBatchPanel,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js';
import { entryStateKind } from '../dist/entry.js';
import { batchEntrySummary } from '../dist/entry-batch.js';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeContainer() {
  return {
    innerHTML: '',
    listeners: [],
    addEventListener(type, fn) {
      if (type === 'click' || type === 'keydown') this.listeners.push(fn);
    },
    removeEventListener(type, fn) {
      const at = this.listeners.indexOf(fn);
      if (at >= 0) this.listeners.splice(at, 1);
    },
  };
}

function snapshotOf(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.2.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  };
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
  };
}

function sessionOf(rows) {
  return {
    version: 1,
    id: 's1',
    selfKey: null,
    stopOnFailure: false,
    order: rows.map((r) => r.key),
    entries: rows.map((r) => ({
      key: r.key,
      phase: r.phase,
      requestId: 'batch:s1:' + r.key,
      targetVersion: r.targetVersion,
      restartRequired: r.restartRequired,
      error: r.error,
      updatedAt: 1,
    })),
    createdAt: 1,
    updatedAt: 1,
  };
}

function fakeBatchCall(rows) {
  const log = [];
  const call = async (name, args) => {
    log.push({ name, args });
    return { ok: true, session: sessionOf(rows), rows, progress: {} };
  };
  return { call, log };
}

function detailActionsOf(html, key) {
  const at = html.indexOf('<div class="dsh-upd-bdetail" data-key="' + key + '"');
  assert.ok(at >= 0, key + ' 的详情要展开着');
  const start = html.indexOf('<span class="dsh-upd-bdetail-actions"', at);
  assert.ok(start >= 0, key + ' 的详情要有自出动作行');
  return html.slice(start, html.indexOf('</span>', start));
}

function detailNoticeOf(html, key) {
  const at = html.indexOf('<div class="dsh-upd-bdetail" data-key="' + key + '"');
  assert.ok(at >= 0, key + ' 的详情要展开着');
  const start = html.indexOf('<div class="dsh-upd-bdetail-notice"', at);
  if (start < 0) return null;
  return html.slice(start, html.indexOf('</div>', start));
}

// ---------- 高优红：跳过口径（详情 vs 单面板） ----------

describe('#88对照·跳过：非法版本不许 toast 撒谎（与单面板同口径）', () => {
  it('详情 row-skip 非法版本：不记跳过也不 toast，与单面板 skip 静默同口径', async () => {
    const box = fakeContainer();
    const rows = [rowOf({ key: 'a', targetVersion: 'xx-bad' })];
    const { call } = fakeBatchCall(rows);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    await panel.act('toggle-details', 'a');
    assert.ok(detailActionsOf(box.innerHTML, 'a').includes('data-act="row-skip"'), '非法版本仍画跳过按钮（与单面板一样画出来）');
    await panel.act('row-skip', 'a');
    await settled();
    const actions = detailActionsOf(box.innerHTML, 'a');
    assert.ok(actions.includes('data-act="row-skip"'), '没记成跳过：按钮仍是跳过不是恢复');
    assert.ok(!actions.includes('data-act="row-resume-skip"'), '没记成跳过：不许出现恢复');
    const notice = detailNoticeOf(box.innerHTML, 'a');
    assert.ok(notice === null || !notice.includes('已跳过'), '不许 toast“已跳过”撒谎，实到：' + notice);
    panel.unmount();
  });

  it('对照·合法版本：详情 row-skip 照常记跳过给恢复（守卫只拦非法）', async () => {
    const box = fakeContainer();
    const rows = [rowOf({ key: 'a', targetVersion: '2.4.0' })];
    const { call } = fakeBatchCall(rows);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    await panel.act('toggle-details', 'a');
    await panel.act('row-skip', 'a');
    await settled();
    assert.ok(detailActionsOf(box.innerHTML, 'a').includes('data-act="row-resume-skip"'), '合法版本跳过后给恢复');
    panel.unmount();
  });
});

// ---------- 绿锁：档位顺序（单 vs 批量聚合， intentional 不同，钉死不许“统一”） ----------

describe('#88对照·档位：单与批量聚合的顺序各有出处，互不覆盖', () => {
  it('单入口：待重启排失败前面（正常终态优先喊）', () => {
    const kind = entryStateKind({
      snapshot: snapshotOf({ blockedReason: 'pending-restart' }),
      error: 'check-failed',
    });
    assert.equal(kind, 'restart');
  });

  it('批量入口：失败排待重启前面（整批里失败最需动手）', () => {
    const rows = [
      rowOf({ key: 'r', phase: 'done', targetVersion: null, restartRequired: true, snapshot: snapshotOf({ latestVersion: '1.0.0', canInstall: false }) }),
      rowOf({ key: 'f', phase: 'failed', targetVersion: '1.2.0', error: 'install-failed' }),
    ];
    const summary = batchEntrySummary({ rows, error: null });
    assert.equal(summary.kind, 'failed');
  });
});

// ---------- 绿锁：dialog 关闭同口径（#50 无回归，两边都有落地回调） ----------

describe('#88对照·关闭：单与批量 dialog 关闭都走 onCloseRequested（#50 无回归）', () => {
  it('批量 dialog：有关闭按钮，act(close) 先调 onCloseRequested', async () => {
    const rows = [rowOf({ key: 'a' })];
    const html = renderBatchPanelHTML({ rows, mode: 'dialog' });
    assert.ok(html.includes('data-act="close"'), '批量 dialog 有关闭按钮');
    const embedded = renderBatchPanelHTML({ rows, mode: 'embedded' });
    assert.ok(!embedded.includes('data-act="close"'), '批量 embedded 无关闭按钮');
    const box = fakeContainer();
    const { call } = fakeBatchCall(rows);
    let closed = 0;
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, mode: 'dialog', pollMs: 60000,
      autoResume: false, checkOnOpen: false,
      onCloseRequested: () => { closed += 1; },
    });
    await settled();
    await panel.act('close');
    await settled();
    assert.equal(closed, 1, '批量关闭先交调用方撤 DOM');
    panel.unmount();
  });

  it('单面板 dialog：footer 有关闭按钮，act(close-view) 先调 onCloseRequested', async () => {
    const input = {
      pluginId: 'p', snapshot: snapshotOf(), manual: null, queue: null,
      mode: 'dialog', showOthers: false,
    };
    const html = renderUpdatePanelHTML(input);
    assert.ok(html.includes('data-action="close-view"'), '单面板 dialog 有 footer 关闭');
    const box = fakeContainer();
    let closed = 0;
    const panel = mountUpdatePanel(box, {
      pluginId: 'p',
      prefix: 't',
      call: async () => ({ ok: true, snapshot: snapshotOf(), manual: null, receipt: null, queue: null }),
      mode: 'dialog',
      pollMs: 60000,
      autoChangelog: false,
      onCloseRequested: () => { closed += 1; },
    });
    await settled();
    await panel.act('close-view');
    await settled();
    assert.equal(closed, 1, '单面板关闭先交调用方撤 DOM');
    panel.unmount();
  });
});
