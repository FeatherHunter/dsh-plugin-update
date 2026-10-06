/**
 * tests/panel-check-layout-stable.test.mjs
 * 查新版布局稳定：按钮预留宽度 + 动态区最小高度 + 查中轮询让路 + 焦点滚动保持。
 * 只测外部行为，传输与容器全用假件。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mountUpdatePanel, renderUpdatePanelHTML, UPDATE_PANEL_CSS } from '../dist/panel.js';
import { mountUpdateBatchPanel, renderBatchPanelHTML, UPDATE_BATCH_PANEL_CSS } from '../dist/panel-batch.js';

const settled = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseSnapshot(o = {}) {
  return { runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0', canInstall: true, blockedReason: null, job: null, ...o };
}
function baseQueue(o = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...o };
}
function countingContainer() {
  const listeners = new Map();
  let html = '';
  let sets = 0;
  return {
    get innerHTML() { return html; },
    set innerHTML(v) { sets += 1; html = v; },
    sets: () => sets,
    addEventListener(t, fn) { listeners.set(t, [...(listeners.get(t) ?? []), fn]); },
    removeEventListener(t, fn) { listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)); },
  };
}

describe('查新版按钮预留宽度：忙闲同宽', () => {
  test('单面板 CSS 预留查新版与安装宽度，且闲态预留转圈槽', () => {
    assert.ok(UPDATE_PANEL_CSS.includes('button:first-child{min-width:8em'), '查新版按钮须有最小宽度');
    assert.ok(UPDATE_PANEL_CSS.includes('button[data-primary="1"]{min-width:7em'), '安装按钮须有最小宽度');
    assert.ok(UPDATE_PANEL_CSS.includes(':not([aria-busy'), '闲态须预留转圈槽，否则忙闲差 19px');
    assert.ok(UPDATE_PANEL_CSS.includes('overflow-anchor:none'), '须关滚动锚定，防整面板漂移');
  });
  test('批量面板 CSS 预留宏按钮与行高', () => {
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('button:first-child'), '批量宏按钮须预留');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('min-width:6em'), '批量宏按钮最小宽度');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-batch-sum,.dsh-upd-batch-ledger{min-height:1.6em}'), '总账须有最小高度');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-brow{min-height:28px}'), '行须有最小高度');
  });
  test('忙闲语义保留：文案切换但可访问性不变', () => {
    const idle = renderUpdatePanelHTML({ snapshot: baseSnapshot(), manual: null, queue: baseQueue(), pluginId: 'p', mode: 'embedded' });
    const busy = renderUpdatePanelHTML({ snapshot: baseSnapshot(), manual: null, queue: baseQueue(), pluginId: 'p', mode: 'embedded', busyAct: 'check' });
    assert.ok(idle.includes('data-action="check"'), '闲态有查新版按钮');
    assert.ok(busy.includes('data-action="check"'), '忙态仍有同一按钮，可恢复焦点');
    assert.ok(busy.includes('aria-busy="true"'), '忙态保留 aria-busy');
    assert.ok(busy.includes('disabled'), '忙态禁用防连点');
    assert.ok(busy.includes('正在查新版'), '忙态文案复用既有措辞，不改文案');
  });
});

describe('查中轮询让路：不与回包帧连跳', () => {
  test('单面板查新版在途时轮询不插帧', async () => {
    let statusCalls = 0;
    let releaseCheck;
    const checkGate = new Promise((r) => { releaseCheck = r; });
    const call = async (name) => {
      if (String(name).endsWith('.updateStatus')) { statusCalls += 1; return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() }; }
      if (String(name).endsWith('.updateCheck')) { await checkGate; return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() }; }
      throw new Error('unknown:' + name);
    };
    const box = countingContainer();
    const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 250, autoChangelog: false });
    try {
      await panel.refresh();
      await settled();
      const before = statusCalls;
      const p = panel.act('check');
      await sleep(600);
      assert.equal(statusCalls, before, '查中轮询须让路，不再只读 status 插帧');
      releaseCheck();
      await p;
      await settled();
      assert.ok(box.innerHTML.includes('data-action="check"'), '回包后按钮仍在，可恢复焦点');
    } finally {
      try { releaseCheck(); } catch {}
      panel.unmount();
    }
  });
  test('批量查中轮询让路', async () => {
    let statusCalls = 0;
    let releaseCheck;
    const gate = new Promise((r) => { releaseCheck = r; });
    const session = { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: ['a'], entries: [], createdAt: 1, updatedAt: 1 };
    const rows = [{ key: 'a', title: 'A', phase: 'pending', targetVersion: null, restartRequired: false, error: null, snapshot: { runningVersion: '1.0.0', canInstall: true } }];
    const call = async (name) => {
      if (String(name).endsWith('.batchStatus')) { statusCalls += 1; return { ok: true, session, rows, progress: null }; }
      if (String(name).endsWith('.batchCheck')) { await gate; return { ok: true, session, rows, progress: null }; }
      throw new Error('unknown:' + name);
    };
    const box = countingContainer();
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 250, autoChangelog: false });
    try {
      await panel.refresh();
      await settled();
      const before = statusCalls;
      const p = panel.act('check');
      await sleep(600);
      assert.equal(statusCalls, before, '批量查中轮询同样让路');
      releaseCheck();
      await p;
      await settled();
      assert.ok(box.innerHTML.includes('data-act="check"'), '批量宏按钮仍在');
    } finally {
      try { releaseCheck(); } catch {}
      panel.unmount();
    }
  });
});

describe('重绘保持可用：无 DOM 也不抛，渲染契约不变', () => {
  test('假容器无 document 时查新版两帧都落盘且不抛', async () => {
    const call = async (name) => {
      if (String(name).endsWith('.updateStatus')) return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() };
      if (String(name).endsWith('.updateCheck')) return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 }, queue: baseQueue() };
      throw new Error('unknown:' + name);
    };
    const box = countingContainer();
    const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call, pollMs: 60000, autoChangelog: false });
    try {
      await panel.refresh();
      const n = box.sets();
      await panel.act('check');
      assert.ok(box.sets() > n, '忙闲两帧仍需落盘，只是布局已稳');
      assert.ok(box.innerHTML.includes('dsh-upd-actions'), '动作行仍在');
    } finally {
      panel.unmount();
    }
  });
});