// #208 P0 面板侧：批量更新面板复用 #214 的客户端日志通道（mode:'batch'）。
// 四类行：update.panel.mount / update.panel.action / update.panel.render.fail / 全局兜底。
// 通道语义与单面板 tests/panel-log.test.mjs、panel-render-fail.test.mjs 同形。
import test from 'node:test';
import assert from 'node:assert/strict';

import { mountUpdateBatchPanel } from '../dist/panel-batch.js';
import { hash8 } from '../dist/hash.js';
import { createClientLogChannel } from '../dist/log/client-queue.js';

const settled = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

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
    order: rows.map((row) => row.key),
    entries: rows.map((row) => ({
      key: row.key,
      phase: row.phase,
      requestId: `batch:s1:${row.key}`,
      targetVersion: row.targetVersion,
      restartRequired: row.restartRequired,
      error: row.error,
      updatedAt: 1,
    })),
    createdAt: 1,
    updatedAt: 1,
  };
}

function fakeContainer() {
  return {
    innerHTML: '',
    addEventListener() {},
    removeEventListener() {},
  };
}

function okReply(rows) {
  return { ok: true, session: sessionOf(rows), rows, progress: {} };
}

// 假批量宿主：所有 `.logAppend` 回合法回执，其余电话按脚本返回/抛出。
function fakeBatchCall(script = {}) {
  const rows = Array.isArray(script.rows) ? script.rows : [];
  const log = [];
  const call = async (name, args) => {
    log.push({ name, args });
    if (name.endsWith('.logAppend')) {
      const sent = Array.isArray(args?.rows) ? args.rows.length : 0;
      return { accepted: sent, dropped: 0 };
    }
    if (name.endsWith('.batchStatus')) {
      if (script.statusThrows) throw new Error(script.statusThrows);
      if (typeof script.status === 'function') return script.status({ name, args });
      return { ...okReply(rows), ...(script.statusExtra ?? {}) };
    }
    if (name.endsWith('.batchCheck')) {
      if (script.checkThrows) throw new Error(script.checkThrows);
      if (typeof script.check === 'function') return script.check({ name, args });
      return okReply(rows);
    }
    if (
      name.endsWith('.batchInstall') ||
      name.endsWith('.batchResume') ||
      name.endsWith('.batchCancel') ||
      name.endsWith('.batchPrefsSave')
    ) {
      if (typeof script.other === 'function') return script.other({ name, args });
      return okReply(rows);
    }
    throw new Error('unexpected-phone:' + name);
  };
  return { call, log };
}

// 调用方注入的通道：timer:null 表示冲刷时机完全由测试控制。
function capturingChannel() {
  const batches = [];
  const channel = createClientLogChannel({
    call: async (name, args) => {
      const queued = Array.isArray(args?.rows) ? args.rows : [];
      batches.push({ name, rows: queued });
      return { accepted: queued.length, dropped: 0 };
    },
    phoneName: 'life.logAppend',
    timer: null,
    visibility: null,
    batchSize: 1000,
  });
  return { channel, batches };
}

function rowsOf(batches) {
  return batches.flatMap((batch) => batch.rows);
}

function eventRows(rows, event) {
  return rows.filter((row) => row.event === event);
}

function actionRows(rows, action) {
  return eventRows(rows, 'update.panel.action').filter((row) => row.fields.action === action);
}

async function flushRows(channel, batches) {
  await settled();
  await channel.flush();
  await settled();
  return rowsOf(batches);
}

function optionsOf(call, options = {}) {
  return {
    prefix: 'life',
    call,
    pollMs: 60000,
    autoResume: false,
    checkOnOpen: false,
    autoChangelog: false,
    autoCompliant: false,
    ...options,
  };
}

test('挂载成功落一条 update.panel.mount：mode 取调用方 mount 名，字段与单面板同形', async () => {
  const cap = capturingChannel();
  const { call } = fakeBatchCall({ rows: [rowOf()] });
  const panel = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call, { clientLog: { channel: cap.channel, mount: 'batch' } }),
  );

  const rows = await flushRows(cap.channel, cap.batches);
  const mounts = eventRows(rows, 'update.panel.mount');

  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].level, 'info');
  assert.deepEqual(mounts[0].fields, {
    mode: 'batch',
    theme: 'default',
    lang: 'zh',
    pollMs: 60000,
    autoCheck: 'disabled',
  });
  assert.equal(eventRows(rows, 'update.panel.render.fail').length, 0);
  panel.unmount();
});

test('挂载行 autoCheck 四态：started / recent / disabled / failed（与单面板同判据）', async () => {
  // disabled：checkOnOpen 关闭。
  {
    const cap = capturingChannel();
    const { call } = fakeBatchCall({ rows: [rowOf()] });
    const panel = mountUpdateBatchPanel(
      fakeContainer(),
      optionsOf(call, { clientLog: { channel: cap.channel } }),
    );
    const rows = await flushRows(cap.channel, cap.batches);
    const mount = eventRows(rows, 'update.panel.mount');
    assert.equal(mount.length, 1);
    assert.equal(mount[0].fields.mode, 'embedded');
    assert.equal(mount[0].fields.autoCheck, 'disabled');
    panel.unmount();
  }

  // started：本次打开确实触发了首次自动检查（盘上无未终态会话）。
  {
    const cap = capturingChannel();
    const freshStatus = () => ({ ok: true, session: sessionOf([]), rows: [rowOf()], progress: {} });
    const { call, log } = fakeBatchCall({ rows: [rowOf()], status: freshStatus });
    const panel = mountUpdateBatchPanel(
      fakeContainer(),
      optionsOf(call, { checkOnOpen: true, clientLog: { channel: cap.channel } }),
    );
    const rows = await flushRows(cap.channel, cap.batches);
    const mount = eventRows(rows, 'update.panel.mount');
    assert.equal(mount.length, 1);
    assert.equal(mount[0].fields.autoCheck, 'started');
    assert.ok(
      log.some((entry) => entry.name.endsWith('.batchCheck')),
      'started 必须真的发出自动检查电话',
    );
    assert.equal(eventRows(rows, 'update.panel.action').length, 0, '自动检查不是用户动作，不落 action 行');
    panel.unmount();
  }

  // recent：上次检查在最近窗口内，不重复自动检查。
  {
    const cap = capturingChannel();
    const { call, log } = fakeBatchCall({
      rows: [rowOf()],
      status: () => ({
        ok: true,
        session: sessionOf([]),
        rows: [rowOf()],
        progress: {},
        inventory: { updatedAt: Date.now() },
      }),
    });
    const panel = mountUpdateBatchPanel(
      fakeContainer(),
      optionsOf(call, { checkOnOpen: true, clientLog: { channel: cap.channel } }),
    );
    const rows = await flushRows(cap.channel, cap.batches);
    const mount = eventRows(rows, 'update.panel.mount');
    assert.equal(mount.length, 1);
    assert.equal(mount[0].fields.autoCheck, 'recent');
    assert.ok(!log.some((entry) => entry.name.endsWith('.batchCheck')));
    panel.unmount();
  }

  // failed：自动检查失败。
  {
    const cap = capturingChannel();
    const { call } = fakeBatchCall({ statusThrows: 'poll-boom', checkThrows: 'poll-boom' });
    const panel = mountUpdateBatchPanel(
      fakeContainer(),
      optionsOf(call, { checkOnOpen: true, clientLog: { channel: cap.channel } }),
    );
    const rows = await flushRows(cap.channel, cap.batches);
    const mount = eventRows(rows, 'update.panel.mount');
    assert.equal(mount.length, 1);
    assert.equal(mount[0].fields.autoCheck, 'failed');
    panel.unmount();
  }
});

test('7 种挂载失败各落一条 phase=mount 的 render.fail，且失败不发挂载行', async () => {
  const goodCall = async () => ({ ok: true });
  const cases = [
    ['container', {}, { prefix: 'life', call: goodCall }],
    ['prefix', fakeContainer(), { prefix: 'bad prefix', call: goodCall }],
    ['call', fakeContainer(), { prefix: 'life' }],
    ['poll-ms', fakeContainer(), { prefix: 'life', call: goodCall, pollMs: 100 }],
    ['mode', fakeContainer(), { prefix: 'life', call: goodCall, mode: 'bogus' }],
    ['theme', fakeContainer(), { prefix: 'life', call: goodCall, theme: 'bogus' }],
    ['theme-tokens', fakeContainer(), { prefix: 'life', call: goodCall, themeTokens: 'red' }],
  ];

  for (const [kind, container, options] of cases) {
    const cap = capturingChannel();
    let error = null;
    try {
      mountUpdateBatchPanel(container, { ...options, clientLog: { channel: cap.channel } });
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof Error, `${kind}：应当场拒绝挂载`);

    const rows = await flushRows(cap.channel, cap.batches);
    const fails = eventRows(rows, 'update.panel.render.fail');
    assert.equal(fails.length, 1, `${kind}：挂载失败恰一条，实际 ${fails.length}`);
    assert.equal(fails[0].level, 'error');
    assert.deepEqual(fails[0].fields, { phase: 'mount', kind, errorHash: hash8(error.message) });
    assert.equal(eventRows(rows, 'update.panel.mount').length, 0, `${kind}：失败不发挂载行`);
  }
});

test('动作行：一条 info/action，含 action/ok/errorKind/durationMs；不带 bytes/truncated', async () => {
  const cap = capturingChannel();
  const { call } = fakeBatchCall({ rows: [rowOf()] });
  const panel = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call, { clientLog: { channel: cap.channel } }),
  );
  await settled();

  await panel.act('toggle-details', 'a');
  await panel.act('check');

  const rows = await flushRows(cap.channel, cap.batches);
  const actions = eventRows(rows, 'update.panel.action');
  assert.equal(actions.length, 2);

  const toggle = actionRows(rows, 'toggle-details');
  assert.equal(toggle.length, 1);
  assert.equal(toggle[0].level, 'info');
  assert.deepEqual(Object.keys(toggle[0].fields).sort(), ['action', 'durationMs', 'errorKind', 'ok']);
  assert.equal(toggle[0].fields.ok, true);
  assert.equal(toggle[0].fields.errorKind, null);
  assert.ok(typeof toggle[0].fields.durationMs === 'number' && toggle[0].fields.durationMs >= 0);

  const check = actionRows(rows, 'check');
  assert.equal(check.length, 1);
  assert.equal(check[0].fields.ok, true);
  assert.ok(!('bytes' in check[0].fields) && !('truncated' in check[0].fields), '批量面板没有 bytes/truncated 语义');
  panel.unmount();
});

test('忙守卫拒掉的点击也落一行：errorKind=busy、ok=false', async () => {
  const cap = capturingChannel();
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const rows = [rowOf()];
  const { call } = fakeBatchCall({ rows, check: () => gate });
  const panel = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call, { clientLog: { channel: cap.channel } }),
  );
  await settled();

  const first = panel.act('check');
  await settled(10);
  await panel.act('row-install', 'a');
  release(okReply(rows));
  await first;

  const all = await flushRows(cap.channel, cap.batches);
  const busy = actionRows(all, 'row-install');
  assert.equal(busy.length, 1);
  assert.equal(busy[0].fields.ok, false);
  assert.equal(busy[0].fields.errorKind, 'busy');
  assert.equal(actionRows(all, 'check')[0].fields.ok, true);
  panel.unmount();
});

test('动作抛错：壳兜底记 errorKind=thrown + errorHash，异常照旧上抛', async () => {
  const cap = capturingChannel();
  const rows = [rowOf({ phase: 'failed', error: 'install-failed', manual: null })];
  const { call } = fakeBatchCall({ rows });
  const throwingTitles = new Proxy(
    {},
    {
      get() {
        throw new Error('copy-boom');
      },
    },
  );
  const panel = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call, { clientLog: { channel: cap.channel }, titles: throwingTitles }),
  );
  await settled();

  await assert.rejects(() => panel.act('copy-all-manual'), /copy-boom/);

  const all = await flushRows(cap.channel, cap.batches);
  const thrown = actionRows(all, 'copy-all-manual');
  assert.equal(thrown.length, 1);
  assert.equal(thrown[0].fields.ok, false);
  assert.equal(thrown[0].fields.errorKind, 'thrown');
  assert.equal(thrown[0].fields.errorHash, hash8('copy-boom'));
  panel.unmount();
});

test('动作被宿主拒绝：动作行如实记 ok:false + 稳定码，重复同码两次都算失败（与单面板同口径）', async () => {
  const cap = capturingChannel();
  const { call } = fakeBatchCall({
    rows: [rowOf()],
    // 只让动作触发的 batchCheck 失败；挂载的首刷走 batchStatus，不受影响。
    check: () => ({ ok: false, error: 'check-failed', errorKind: 'check-failed' }),
  });
  const panel = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call, { clientLog: { channel: cap.channel } }),
  );
  await settled();

  // 连点两次：第二次与第一次同错误码——动作壳必须按「新失败」记，而不是看字符串有没有变。
  await panel.act('check');
  await panel.act('check');

  const all = await flushRows(cap.channel, cap.batches);
  const actions = actionRows(all, 'check');
  assert.equal(actions.length, 2);
  for (const row of actions) {
    assert.equal(row.fields.ok, false);
    assert.equal(row.fields.errorKind, 'check-failed');
    assert.equal(row.fields.errorHash, hash8('check-failed'));
  }
  panel.unmount();
});

test('渲染失败：phase=paint/kind=render，60 秒内同指纹只一条且面板不碎', async () => {
  const cap = capturingChannel();
  const { call } = fakeBatchCall({ rows: [rowOf()] });
  const panel = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call, {
      clientLog: { channel: cap.channel },
      titles: new Proxy(
        {},
        {
          get() {
            throw new Error('paint-boom');
          },
        },
      ),
    }),
  );
  await settled();

  await panel.refresh();
  await panel.refresh();

  const rows = await flushRows(cap.channel, cap.batches);
  const fails = eventRows(rows, 'update.panel.render.fail');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].level, 'error');
  assert.deepEqual(fails[0].fields, { phase: 'paint', kind: 'render', errorHash: hash8('paint-boom') });
  assert.ok(!JSON.stringify(fails).includes('paint-boom'), '只留指纹，不落原文');
  panel.unmount();
});

test('轮询传输失败：phase=poll/kind=transport；同指纹去重；挂载行如实记 failed', async () => {
  const cap = capturingChannel();
  const { call } = fakeBatchCall({ statusThrows: 'poll-boom', checkThrows: 'poll-boom' });
  const panel = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call, { checkOnOpen: true, clientLog: { channel: cap.channel } }),
  );
  await settled();

  await panel.refresh();
  await panel.refresh();

  const rows = await flushRows(cap.channel, cap.batches);
  const fails = eventRows(rows, 'update.panel.render.fail').filter((row) => row.fields.phase === 'poll');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].level, 'error');
  assert.equal(fails[0].fields.kind, 'transport');
  assert.equal(fails[0].fields.errorHash, hash8('poll-boom'));

  const mount = eventRows(rows, 'update.panel.mount');
  assert.equal(mount.length, 1);
  assert.equal(mount[0].fields.autoCheck, 'failed');
  panel.unmount();
});

test('全局兜底：error/unhandledrejection → phase=global；只记指纹；卸载即摘', async () => {
  const cap = capturingChannel();
  const listeners = new Map();
  const hadAdd = Object.prototype.hasOwnProperty.call(globalThis, 'addEventListener');
  const hadRemove = Object.prototype.hasOwnProperty.call(globalThis, 'removeEventListener');
  const previousAdd = globalThis.addEventListener;
  const previousRemove = globalThis.removeEventListener;

  globalThis.addEventListener = (type, handler) => {
    listeners.set(type, handler);
  };
  globalThis.removeEventListener = (type) => {
    listeners.delete(type);
  };

  try {
    const { call } = fakeBatchCall({ rows: [] });
    const panel = mountUpdateBatchPanel(
      fakeContainer(),
      optionsOf(call, { clientLog: { channel: cap.channel } }),
    );
    await settled();

    assert.equal(typeof listeners.get('error'), 'function');
    assert.equal(typeof listeners.get('unhandledrejection'), 'function');

    listeners.get('error')({ message: 'global-boom' });
    listeners.get('unhandledrejection')({ reason: new Error('rej-boom') });

    const rows = await flushRows(cap.channel, cap.batches);
    const globals = eventRows(rows, 'update.panel.render.fail').filter((row) => row.fields.phase === 'global');
    assert.equal(globals.length, 2);
    assert.deepEqual(globals[0].fields, { phase: 'global', kind: 'uncaught', errorHash: hash8('global-boom') });
    assert.deepEqual(globals[1].fields, { phase: 'global', kind: 'unhandled', errorHash: hash8('rej-boom') });
    assert.ok(!JSON.stringify(globals).includes('global-boom'), '只留指纹，不落原文');

    panel.unmount();
    assert.equal(listeners.size, 0, '卸载要摘掉全局监听');
  } finally {
    if (hadAdd) globalThis.addEventListener = previousAdd;
    else delete globalThis.addEventListener;
    if (hadRemove) globalThis.removeEventListener = previousRemove;
    else delete globalThis.removeEventListener;
  }
});

test('默认自建通道：<prefix>.logAppend 收行；unmount 冲刷 pending 后销毁、不再发', async () => {
  const { call, log } = fakeBatchCall({ rows: [rowOf()] });
  const panel = mountUpdateBatchPanel(fakeContainer(), optionsOf(call));
  await settled();

  assert.equal(log.filter((entry) => entry.name === 'life.logAppend').length, 0, '1 秒冲刷未到、卸载未到：行还在缓冲里');

  panel.unmount();
  await settled(50);

  const appends = log.filter((entry) => entry.name === 'life.logAppend');
  assert.equal(appends.length, 1, '卸载时 dispose 会尽力冲刷 pending');
  const appendedRows = appends[0].args.rows;
  const mount = appendedRows.filter((row) => row.event === 'update.panel.mount');
  assert.equal(mount.length, 1);
  assert.equal(mount[0].fields.mode, 'embedded');
  assert.equal(mount[0].fields.autoCheck, 'disabled');

  await settled(150);
  assert.equal(log.filter((entry) => entry.name === 'life.logAppend').length, 1, '销毁后不再发');
});

test('默认自建通道按 1 秒定时冲刷，不必等卸载', async () => {
  const { call, log } = fakeBatchCall({ rows: [] });
  const panel = mountUpdateBatchPanel(fakeContainer(), optionsOf(call));
  await settled(1150);

  const appends = log.filter((entry) => entry.name === 'life.logAppend');
  assert.equal(appends.length, 1);
  assert.ok(appends[0].args.rows.some((row) => row.event === 'update.panel.mount'));

  panel.unmount();
  await settled(50);
  assert.equal(log.filter((entry) => entry.name === 'life.logAppend').length, 1);
});

test('注入通道：unmount 不 dispose；{ channel: null } 完全关闭', async () => {
  // 注入通道归调用方所有，面板只收不销毁。
  const cap = capturingChannel();
  const { call } = fakeBatchCall({ rows: [] });
  const panel = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call, { clientLog: { channel: cap.channel, mount: 'batch' } }),
  );
  await settled();
  panel.unmount();
  await settled();

  cap.channel.emit('info', 'update.panel.state', {
    state: 'idle',
    theme: 'default',
    tokensApplied: false,
    fallback: false,
  });
  await cap.channel.flush();
  assert.ok(
    rowsOf(cap.batches).some((row) => row.event === 'update.panel.state'),
    'unmount 不 dispose 调用方通道',
  );

  // { channel: null }：完全关闭，一条都不发。
  const { call: call2, log: log2 } = fakeBatchCall({ rows: [] });
  const panel2 = mountUpdateBatchPanel(
    fakeContainer(),
    optionsOf(call2, { clientLog: null }),
  );
  await settled();
  await panel2.refresh();
  panel2.unmount();
  await settled(50);
  assert.equal(log2.filter((entry) => entry.name.endsWith('.logAppend')).length, 0);
});
