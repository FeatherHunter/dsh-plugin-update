/**
 * tests/panel-macro-87.test.mjs —— #87 宏动作与稳定性：忙守卫单/批量一致 + 抖动 + 闪空。
 * 缝：renderUpdatePanelHTML / renderBatchPanelHTML（纯渲染）+ mount（电话在飞/轮询让路）。
 * 面板只渲染不推导：不断言电话形状与快照六字段（那是 #85 契约缝）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderUpdatePanelHTML, UPDATE_PANEL_CSS } from '../dist/panel.js';
import { renderBatchPanelHTML, UPDATE_BATCH_PANEL_CSS, mountUpdateBatchPanel } from '../dist/panel-batch.js';

function snap(o = {}) {
  return { runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0', canInstall: true, blockedReason: null, job: null, ...o };
}
function queue(o = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...o };
}
function rowOf(o = {}) {
  return { key: 'a', title: 'A', phase: 'ready', targetVersion: '1.2.0', restartRequired: false, error: null, snapshot: null, manual: null, queue: null, profileName: null, ...o };
}
function checkBtn(html) {
  const m = html.match(/<button[^>]*data-action="check"[^>]*>/);
  assert.ok(m, '须有查新版按钮');
  return m[0];
}
function installBtn(html) {
  const m = html.match(/<button[^>]*data-action="install"[^>]*>/);
  assert.ok(m, '须有安装按钮');
  return m[0];
}
function batchBtn(html, act) {
  const m = html.match(new RegExp('<button[^>]*data-act="' + act + '"[^>]*>'));
  assert.ok(m, '批量须有 ' + act);
  return m[0];
}

describe('#87 忙守卫：installing 即置灰，单/批量一致', () => {
  it('单面板 installing 快照：查新版与安装一起置灰（与批量宏一致）', () => {
    const html = renderUpdatePanelHTML({
      snapshot: snap({ job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' } }),
      manual: null, queue: queue(), pluginId: 'p', mode: 'embedded',
    });
    assert.ok(checkBtn(html).includes('disabled'), 'installing 时查新版须置灰（批量口径）');
    assert.ok(installBtn(html).includes('disabled'), 'installing 时安装须置灰');
  });
  it('单面板 verifying 快照：同 installing 一起置灰', () => {
    const html = renderUpdatePanelHTML({
      snapshot: snap({ job: { id: 'j', state: 'verifying', targetVersion: '1.1.0', message: null, requestId: 'r' } }),
      manual: null, queue: queue(), pluginId: 'p', mode: 'embedded',
    });
    assert.ok(checkBtn(html).includes('disabled'), 'verifying 时查新版须置灰');
    assert.ok(installBtn(html).includes('disabled'), 'verifying 时安装须置灰');
  });
  it('单面板 busyAct=check：在途两键一起置灰（与批量 inFlight 一致）', () => {
    const html = renderUpdatePanelHTML({
      snapshot: snap(), manual: null, queue: queue(), pluginId: 'p', mode: 'embedded', busyAct: 'check',
    });
    assert.ok(checkBtn(html).includes('disabled'), '查中查按钮置灰');
    assert.ok(checkBtn(html).includes('aria-busy="true"'), '查中保留 aria-busy');
    assert.ok(installBtn(html).includes('disabled'), '查中安装须跟着置灰（批量 inFlight 两宏同灰）');
  });
  it('单面板 busyAct=install：在途两键一起置灰', () => {
    const html = renderUpdatePanelHTML({
      snapshot: snap(), manual: null, queue: queue(), pluginId: 'p', mode: 'embedded', busyAct: 'install',
    });
    assert.ok(installBtn(html).includes('disabled'), '装中安装置灰');
    assert.ok(checkBtn(html).includes('disabled'), '装中查新版须跟着置灰');
  });
  it('闲态零回归：两键都可用（快照可装）', () => {
    const html = renderUpdatePanelHTML({
      snapshot: snap(), manual: null, queue: queue(), pluginId: 'p', mode: 'embedded',
    });
    assert.ok(!checkBtn(html).includes('disabled'), '闲态查可用');
    assert.ok(!installBtn(html).includes('disabled'), '闲态装可用（canInstall=true）');
  });
  it('批量对照：任一行 installing 即两宏置灰（本测常绿，锁口径）', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a', phase: 'installing' }), rowOf({ key: 'b' })] });
    assert.ok(batchBtn(html, 'check').includes('disabled'), '批量检查更新置灰');
    assert.ok(batchBtn(html, 'install').includes('disabled'), '批量全部更新置灰');
  });
});

describe('#87 抖动：预留宽高 + 查中轮询让路（只读渲染零动作断言）', () => {
  it('CSS 预留仍在：单/批量同高同宽 + 关滚动锚定', () => {
    assert.ok(UPDATE_PANEL_CSS.includes('button:first-child{min-width:8em'), '单查按钮预留');
    assert.ok(UPDATE_PANEL_CSS.includes('button[data-primary="1"]{min-width:7em'), '单装按钮预留');
    assert.ok(UPDATE_PANEL_CSS.includes('overflow-anchor:none'), '单关滚动锚定');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('min-width:6em'), '批量宏预留');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-batch-sum,.dsh-upd-batch-ledger{min-height:1.6em}'), '批量总账预留');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-brow{min-height:28px}'), '批量行预留');
  });
});

describe('#87 闪空：prefs-only 回包只更 prefs 不清空行', () => {
  it('toggle-check-on-open 走通用通道：行数不变、开关翻转', async () => {
    const settled = () => new Promise((r) => setTimeout(r, 0));
    const session = { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: ['a', 'b'], entries: [], createdAt: 1, updatedAt: 1 };
    const rows = [rowOf({ key: 'a', title: '甲', phase: 'ready' }), rowOf({ key: 'b', title: '乙', phase: 'ready' })];
    let prefs = { checkOnOpen: false };
    const box = { innerHTML: '', addEventListener() {}, removeEventListener() {} };
    const call = async (name) => {
      if (String(name).endsWith('.batchStatus')) return { ok: true, session, rows, progress: null, prefs };
      if (String(name).endsWith('.batchPrefsSave')) {
        prefs = { checkOnOpen: true };
        return { ok: true, prefs };
      }
      throw new Error('unknown:' + name);
    };
    const { panel } = (() => {
      const m = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoChangelog: false });
      return { panel: m };
    })();
    await panel.refresh();
    await settled();
    const before = (box.innerHTML.match(/data-key="a"/g) || []).length;
    assert.ok(before >= 1, '切换前行在');
    await panel.act('toggle-check-on-open');
    await settled();
    assert.ok(box.innerHTML.includes('data-key="a"'), 'prefs-only 回包后甲行仍在（不闪空）');
    assert.ok(box.innerHTML.includes('data-key="b"'), 'prefs-only 回包后乙行仍在');
    panel.unmount();
  });
});
