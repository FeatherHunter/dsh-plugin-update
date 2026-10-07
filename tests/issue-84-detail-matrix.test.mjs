/**
 * tests/issue-84-detail-matrix.test.mjs —— #84 详情弹窗单查与复制：支持矩阵。
 *
 * 缝：renderBatchPanelHTML / mountUpdateBatchPanel(act + call 记录) / UPDATE_BATCH_PANEL_CSS。
 * 只测外部行为/产物，不碰实现细节；文案只认字典已有键（bilingual 零新增）。
 *
 * 矩阵（详情 = 单插件内核只读 + 批量自出动作行）：
 *   单查 / 重试 / 复制诊断 / 复制手工 / 跳过 ＋ 死按钮摘净 ＋ 不嵌套滚动。
 * 高优（单查＋复制失败原因）先红后绿，其余为绿基线。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_BATCH_PANEL_CSS,
  mountUpdateBatchPanel,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeContainer() {
  const listeners = [];
  return {
    innerHTML: '',
    listeners,
    addEventListener(type, fn) {
      if (type === 'click') listeners.push(fn);
    },
    removeEventListener(type, fn) {
      const at = listeners.indexOf(fn);
      if (at >= 0) listeners.splice(at, 1);
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

const SINGLE_PHONES = {
  updateStatus: 'p.updateStatus',
  updateCheck: 'p.updateCheck',
  updateInstall: 'p.updateInstall',
  updateChangelog: 'p.updateChangelog',
};

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

function fakeCall(rows, reply) {
  const log = [];
  const call = async (name, args) => {
    log.push({ name, args });
    if (reply) return reply(name, args);
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

// ---------- 单查（高优红） ----------

describe('#84矩阵·单查：详情里单独查这一家', () => {
  it('详情有单查入口：行带 phoneNames.updateCheck 时动作行出现单查按钮', async () => {
    const box = fakeContainer();
    const rows = [rowOf({ key: 'a', phoneNames: { ...SINGLE_PHONES } })];
    const { call } = fakeCall(rows);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    await panel.act('toggle-details', 'a');
    const actions = detailActionsOf(box.innerHTML, 'a');
    assert.ok(actions.includes('data-act="row-check"'), '单查按钮要在详情动作行里：' + actions);
    assert.ok(actions.includes('检查更新'), '单查沿用已有文案键，不新增键');
    panel.unmount();
  });

  it('单查打该家自己的电话：只调行 phoneNames.updateCheck，不碰批量电话', async () => {
    const rows = [rowOf({ key: 'a', phoneNames: { ...SINGLE_PHONES } })];
    const box = fakeContainer();
    const { call, log } = fakeCall(rows, (name) => {
      if (name === 'p.updateCheck') return { ok: true, snapshot: snapshotOf(), manual: null, queue: null };
      return { ok: true, session: sessionOf(rows), rows, progress: {} };
    });
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    log.length = 0;
    await panel.act('row-check', 'a');
    await settled();
    const names = log.map((e) => e.name);
    assert.ok(names.includes('p.updateCheck'), '必须打行自己的单查电话，实到：' + names.join(','));
    assert.ok(!names.includes('life.batchCheck'), '不许顺手全量查：单查只动这一家');
    panel.unmount();
  });

  it('老宿主无 phoneNames 时不画单查按钮（诚实缺省，全局检查更新仍在）', async () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a' })], expandedKey: 'a' });
    const actions = detailActionsOf(html, 'a');
    assert.ok(!actions.includes('data-act="row-check"'), '没给行电话名就不能画单查');
    assert.ok(html.includes('data-act="check"'), '全局检查更新宏仍在，可回退全量查');
  });
});

// ---------- 重试（绿基线） ----------

describe('#84矩阵·重试：失败行详情给重试', () => {
  it('失败行详情给重试，打到批量安装只推这一家', async () => {
    const rows = [rowOf({ key: 'a', phase: 'failed', error: 'install-failed' })];
    const box = fakeContainer();
    const { call, log } = fakeCall(rows);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    await panel.act('toggle-details', 'a');
    const actions = detailActionsOf(box.innerHTML, 'a');
    assert.ok(actions.includes('>重试</button>'), '失败行详情给重试');
    log.length = 0;
    await panel.act('row-install', 'a');
    await settled();
    assert.equal(log.length, 1);
    assert.equal(log[0].name, 'life.batchInstall');
    assert.deepEqual(log[0].args, { keys: ['a'] });
    panel.unmount();
  });
});

// ---------- 复制诊断（高优红） ----------

describe('#84矩阵·复制诊断：失败时 diag/env/queue 进复制文本', () => {
  async function copyDiagOf(row) {
    const copied = [];
    const box = fakeContainer();
    const { call } = fakeCall([row]);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
      copyText: (text) => { copied.push(text); },
    });
    await settled();
    await panel.act('toggle-details', row.key);
    await panel.act('row-copy-diag', row.key);
    panel.unmount();
    assert.equal(copied.length, 1, '复制要有且仅有一段文本');
    return copied[0];
  }

  it('diag 结构化字段进复制文本：阶段/路由/方法/HTTP/耗时/源', async () => {
    const text = await copyDiagOf(rowOf({
      key: 'a',
      pluginId: 'demo',
      phase: 'failed',
      error: 'check-failed',
      diag: {
        v: 1,
        stage: 'fetch-release',
        route: 'registry',
        method: 'https',
        httpStatus: 429,
        latencyMs: 123,
        registryHost: 'registry.example.com',
        detail: '远端限流',
      },
    }));
    assert.ok(text.includes('check-failed'), '稳定码在');
    assert.ok(text.includes('远端限流'), '摘要在');
    for (const want of ['fetch-release', 'registry', 'https', '429', '123', 'registry.example.com']) {
      assert.ok(text.includes(want), 'diag 结构化字段要进复制文本，缺：' + want + '\n' + text);
    }
  });

  it('env/queue 进复制文本：宿主种类/使用范围/队列位置', async () => {
    const text = await copyDiagOf(rowOf({
      key: 'a',
      pluginId: 'demo',
      phase: 'failed',
      error: 'install-failed',
      hostKind: 'desktop',
      profileName: 'web',
      queue: { busy: true, position: 2, waiting: [], owner: null },
    }));
    for (const want of ['desktop', 'web']) {
      assert.ok(text.includes(want), 'env 要进复制文本，缺：' + want + '\n' + text);
    }
    assert.ok(text.includes('排队第 2 位') || text.includes('队列'), '队列位置要进复制文本：' + text);
  });
});

// ---------- 复制手工（绿基线） ----------

describe('#84矩阵·复制手工：有才画、无不画', () => {
  it('有手工命令才画复制手工命令，且逐字复制', async () => {
    const manual = 'npm i -g demo@2.0.0';
    const copied = [];
    const box = fakeContainer();
    const { call } = fakeCall([rowOf({ key: 'a', manual })]);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
      copyText: (text) => { copied.push(text); },
    });
    await settled();
    await panel.act('toggle-details', 'a');
    assert.ok(detailActionsOf(box.innerHTML, 'a').includes('row-copy-manual'), '有手工命令就画');
    await panel.act('row-copy-manual', 'a');
    assert.equal(copied[0], manual, '逐字复制');
    panel.unmount();
  });

  it('没手工命令就不画复制手工命令，复制诊断恒在', async () => {
    const box = fakeContainer();
    const { call } = fakeCall([rowOf({ key: 'a', phase: 'failed', error: 'check-failed' })]);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    await panel.act('toggle-details', 'a');
    const actions = detailActionsOf(box.innerHTML, 'a');
    assert.ok(!actions.includes('row-copy-manual'), '无手工命令不画');
    assert.ok(actions.includes('data-act="row-copy-diag"'), '复制诊断恒在');
    panel.unmount();
  });
});

// ---------- 跳过（绿基线） ----------

describe('#84矩阵·跳过：详情与行内同一通道', () => {
  it('可安装行详情给跳过，跳过后给恢复', async () => {
    const rows = [rowOf({ key: 'a', pluginId: 'skip-84', targetVersion: '2.4.0' })];
    const box = fakeContainer();
    const { call } = fakeCall(rows);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    await panel.act('toggle-details', 'a');
    assert.match(detailActionsOf(box.innerHTML, 'a'), /data-act="row-skip"/, '详情给跳过');
    await panel.act('row-skip', 'a');
    await panel.act('toggle-details', 'a');
    await panel.act('toggle-details', 'a');
    assert.match(detailActionsOf(box.innerHTML, 'a'), /data-act="row-resume-skip"/, '跳过后详情给恢复');
    panel.unmount();
  });
});

// ---------- 死按钮摘净＋不嵌套滚动（绿基线） ----------

describe('#84矩阵·死按钮与滚动', () => {
  it('详情里没有 data-action 死按钮：内核残留整颗摘掉', async () => {
    const busyQueue = { busy: true, owner: null, waiting: [{ pluginId: 'other', requestId: 'r', targetVersion: '9.9.9', enqueuedAt: 1 }], position: 2 };
    const box = fakeContainer();
    const { call } = fakeCall([rowOf({ key: 'a', queue: busyQueue, manual: 'npm i -g demo@1.2.0' })]);
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false,
    });
    await settled();
    await panel.act('toggle-details', 'a');
    const html = box.innerHTML;
    assert.ok(!/\bdata-action=/.test(html.slice(html.indexOf('dsh-upd-bdetail'))), '详情里不许有内核 data-action');
    panel.unmount();
  });

  it('详情不嵌套滚动：dialog 下详情仍 embedded，CSS 中性化 overlay 滚动', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf()], mode: 'dialog', expandedKey: 'a' });
    assert.ok(html.includes('data-mode="embedded"'), '详情内嵌');
    assert.ok(
      UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-overlay .dsh-upd-bdetail .dsh-upd{max-height:none;overflow:visible}'),
      'overlay 里的详情中性化滚动',
    );
  });
});
