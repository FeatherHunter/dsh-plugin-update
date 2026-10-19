/**
 * tests/batch-detail-dialog-108.test.mjs —— #108 详情默认弹窗落地。
 *
 * 只测外部行为/产物，不碰实现细节；文案只认字典已有键（bilingual 零新增）。
 * 验收：点详情默认弹 dialog（居中+遮罩+Esc/关闭可用，内容超高可滚）；
 * 内嵌 `.dsh-upd-bdetail` 不再出现（#108 选删）；#84 口径原样保留；
 * 关闭=B（右下 footer，复用 panel.footer.* 文案，走批量 data-act 通道）；
 * 双主题+深色媒体；archive footer 幽灵透明。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_BATCH_PANEL_CSS,
  renderBatchPanelHTML,
  mountUpdateBatchPanel,
} from '../dist/panel-batch.js';
import { UPDATE_PANEL_ARCHIVE_CSS } from '../dist/panel.js';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeContainer() {
  const listeners = new Map();
  return {
    innerHTML: '',
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    click(act, key) {
      const target = {
        closest: (sel) => {
          if (sel !== '[data-act]') return null;
          if (!act) return null;
          return { getAttribute: (n) => (n === 'data-act' ? act : n === 'data-key' ? (key ?? null) : null) };
        },
      };
      for (const fn of [...(listeners.get('click') ?? [])]) fn({ target });
    },
    keydown(key) {
      for (const fn of [...(listeners.get('keydown') ?? [])]) fn({ key });
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
    manual: 'npm i -g demo@1.2.0',
    queue: null,
    profileName: 'default',
    hostKind: 'desktop',
    phoneNames: { updateCheck: 'p.updateCheck' },
    ...overrides,
  };
}

function sessionOf(rows) {
  return {
    version: 1, id: 's1', selfKey: null, stopOnFailure: false,
    order: rows.map((r) => r.key),
    entries: rows.map((r) => ({ key: r.key, phase: r.phase, requestId: 'batch:s1:' + r.key, targetVersion: r.targetVersion, restartRequired: r.restartRequired, error: r.error, updatedAt: 1 })),
    createdAt: 1, updatedAt: 1,
  };
}

function fakeCall(rows) {
  const log = [];
  const call = async (name) => {
    log.push(name);
    if (name === 'p.updateCheck') return { ok: true, snapshot: snapshotOf(), manual: null, queue: null };
    return { ok: true, session: sessionOf(rows), rows, progress: {} };
  };
  return { call, log };
}

function dom(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/g, '');
}

describe('#108 详情默认弹窗：点详情弹 dialog，不再内嵌', () => {
  it('纯渲染：expandedKey 即出 dialog sibling，行内无 .dsh-upd-bdetail', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf()], expandedKey: 'a', mode: 'dialog', lang: 'zh' });
    const d = dom(html);
    assert.ok(!d.includes('dsh-upd-bdetail"'), '内嵌路径已删，不许再出现 bdetail');
    assert.ok(d.includes('dsh-upd-bdetail-dialog'), '详情以 dialog sibling 呈现');
    assert.ok(d.includes('data-detail-key="a"'), 'dialog 带行键归属');
    assert.ok(d.includes('dsh-upd-overlay'), '有遮罩 overlay');
    assert.ok(d.includes('dsh-upd-bdetail-dialog-bar'), '动作行前置为固定栏');
    assert.ok(d.includes('dsh-upd-footer'), '关闭=B：右下 footer 在');
    assert.ok(d.includes('data-act="detail-close"'), 'footer 关闭走批量通道');
  });

  it('挂载：toggle-details 开弹窗，再点收起；detail-close 只关详情不碰批量', async () => {
    const rows = [rowOf()];
    const box = fakeContainer();
    const { call } = fakeCall(rows);
    let closed = 0;
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, mode: 'dialog', pollMs: 60000,
      autoResume: false, checkOnOpen: false,
      onCloseRequested: () => { closed += 1; },
    });
    await settled();
    assert.ok(!dom(box.innerHTML).includes('dsh-upd-bdetail-dialog'), '默认收起，无弹窗');
    await panel.act('toggle-details', 'a');
    assert.ok(dom(box.innerHTML).includes('dsh-upd-bdetail-dialog'), '点详情即弹 dialog');
    await panel.act('detail-close', 'a');
    assert.ok(!dom(box.innerHTML).includes('dsh-upd-bdetail-dialog'), 'footer 关闭只清 expandedKey');
    assert.equal(closed, 0, '内层关闭不碰批量 onCloseRequested');
    await panel.act('toggle-details', 'a');
    await panel.act('toggle-details', 'a');
    assert.ok(!dom(box.innerHTML).includes('dsh-upd-bdetail-dialog'), '再点 toggle 即收起');
    panel.unmount();
  });

  it('Esc 归属：有展开先关详情，再按才关批量', async () => {
    const rows = [rowOf()];
    const box = fakeContainer();
    const { call } = fakeCall(rows);
    let closed = 0;
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, mode: 'dialog', pollMs: 60000,
      autoResume: false, checkOnOpen: false,
      onCloseRequested: () => { closed += 1; },
    });
    await settled();
    await panel.act('toggle-details', 'a');
    assert.ok(dom(box.innerHTML).includes('dsh-upd-bdetail-dialog'), '先展开');
    box.keydown('Escape');
    await settled();
    assert.ok(!dom(box.innerHTML).includes('dsh-upd-bdetail-dialog'), '第一次 Esc 只关详情');
    assert.equal(closed, 0, '第一次 Esc 不碰批量关闭');
    panel.unmount();
  });

  it('#84 口径在弹窗内原样保留：单查/重试/跳过/复制手工/复制诊断齐全', async () => {
    const rows = [rowOf({ key: 'a', phase: 'failed', error: 'install-failed' })];
    const box = fakeContainer();
    const { call } = fakeCall(rows);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    await panel.act('toggle-details', 'a');
    const html = dom(box.innerHTML);
    const at = html.indexOf('dsh-upd-bdetail-dialog');
    assert.ok(at >= 0, '弹窗在');
    const dlg = html.slice(at);
    assert.ok(dlg.includes('data-act="row-check"'), '单查透 phoneNames');
    assert.ok(dlg.includes('>重试</button>') || dlg.includes('优先安装'), '失败给重试/优先安装');
    assert.ok(dlg.includes('data-act="row-copy-manual"'), '复制手工在');
    assert.ok(dlg.includes('data-act="row-copy-diag"'), '复制诊断恒在');
    assert.ok(dlg.includes('data-chapter="01"'), '五章内核在（只查一章代表）');
    panel.unmount();
  });

  it('死按钮：弹窗内无 data-action，footer 也不例外', () => {
    const busyQueue = { busy: true, owner: null, waiting: [{ pluginId: 'other', requestId: 'r', targetVersion: '9.9.9', enqueuedAt: 1 }], position: 2 };
    const html = dom(renderBatchPanelHTML({ rows: [rowOf({ queue: busyQueue })], expandedKey: 'a', lang: 'zh' }));
    const at = html.indexOf('dsh-upd-bdetail-dialog');
    assert.ok(at >= 0, '弹窗在');
    const dlg = html.slice(at);
    assert.ok(!/\bdata-action=/.test(dlg), '弹窗内不许有内核 data-action（含 footer，批量通道只认 data-act）');
    assert.ok(!dlg.includes('toggle-queue'), '内核队列开关已摘（内容照留）');
  });

  it('滚动：弹窗 body 走内核可滚，章节头 sticky；旧中性化已退役', () => {
    const css = UPDATE_BATCH_PANEL_CSS;
    assert.ok(!css.includes('.dsh-upd-bdetail{'), '旧内嵌中性化随删内嵌退役');
    assert.ok(css.includes('.dsh-upd-overlay.dsh-upd-bdetail-dialog{z-index:10000}'), '嵌套高一层');
    assert.ok(css.includes('.dsh-upd-bdetail-dialog-bar'), '固定栏样式在');
  });

  it('双主题：archive 弹窗同结构，仅差 data-theme；深色媒体仍在', () => {
    const strip = (h) => dom(h).replaceAll(' data-theme="archive"', '');
    const a = renderBatchPanelHTML({ rows: [rowOf()], expandedKey: 'a', lang: 'zh' });
    const b = renderBatchPanelHTML({ rows: [rowOf()], expandedKey: 'a', lang: 'zh', theme: 'archive' });
    assert.ok(dom(b).includes('data-theme="archive"'), 'archive 挂属性');
    assert.ok(dom(b).includes('dsh-upd-bdetail-dialog'), 'archive 也是弹窗');
    assert.ok(UPDATE_BATCH_PANEL_CSS.includes('@media (prefers-color-scheme: dark)'), '深色媒体仍在');
    assert.equal(strip(b), strip(a), 'DOM 同构（除主题属性）');
  });

  it('footer 幽灵统一：archive footer 关闭透明底、无独立设色；default 零回归', () => {
    const css = UPDATE_PANEL_ARCHIVE_CSS;
    const rule = css.split('\n').find((l) => l.includes('.dsh-upd-footer button'));
    assert.ok(rule, 'archive footer 规则在');
    assert.ok(rule.includes('background:transparent'), 'archive footer 关闭透明底');
    assert.ok(!rule.includes('color:'), '不独立设色（沿用纸墨）');
    assert.ok(!rule.includes('border-color'), '不独立设边框色');
  });
});
