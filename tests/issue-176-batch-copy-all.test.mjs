/**
 * tests/issue-176-batch-copy-all.test.mjs —— #176 批量面板失败横幅：统一「复制诊断」「复制手工命令」。
 *
 * 缝：renderBatchPanelHTML（横幅 HTML）/ mountUpdateBatchPanel（点按钮 → copyText 出口 + 底部回执）/
 * dist 导出的纯聚合函数（batchFailedRows / batchFailedDiagText / batchFailedManualText）。
 * 只测外部行为与产物，不碰实现细节。
 *
 * 覆盖：按钮出现/消失、失败集合边界（排队忙 / 等重启 / 已装合规版都不算失败）、
 * 无手工命令时按钮置灰并说明、两段聚合文本的内容与顺序（块间空行 / # 注释行）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_BATCH_PANEL_CSS,
  batchFailedDiagText,
  batchFailedManualText,
  batchFailedRows,
  mountUpdateBatchPanel,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const FAILED_BANNER = '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻"';
// #92：置灰说明与注释行按快照原因说清；本文件行快照的默认原因是「没有安全候选」。
const NO_SAFE_ZH = '没有可安全执行的目标版本或参数：可能候选都低于运行版、不在当前通道，或范围名/源地址无法安全拼进命令。请等新版发布后再查，或先按第 5.2 节的受阻原因修好环境。';
const NO_SAFE_EN = 'No safe target version or argument set: candidates may all be older than the running version, outside the current channel, or the scope name/registry cannot be safely embedded in a command. Check again after a newer version ships, or fix the blocked reason in section 5.2 first.';
const ABSENT_ZH = '当前没有可用的手工命令。' + NO_SAFE_ZH;
const ABSENT_EN = 'No manual command is available right now. ' + NO_SAFE_EN;
const NL = String.fromCharCode(10);

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
    latestVersion: '2.0.0',
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
    phase: 'failed',
    targetVersion: '2.0.0',
    restartRequired: false,
    error: 'install-failed',
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

function fakeCall(rows) {
  return async () => ({ ok: true, session: sessionOf(rows), rows, progress: {} });
}

/** 失败横幅整段（从横幅开头到框外行动句之前）：按钮/名单/置灰断言都只认这一段。 */
function failedBannerOf(html) {
  const at = html.indexOf(FAILED_BANNER);
  assert.ok(at >= 0, '失败横幅要在：' + html.slice(0, 300));
  const rest = html.slice(at);
  const sub = rest.indexOf('<div class="dsh-upd-banner-sub"');
  return sub >= 0 ? rest.slice(0, sub) : rest.slice(0, 2400);
}

function attrsOfButton(html, act) {
  const m = html.match(new RegExp('<button type="button" data-act="' + act + '"[^>]*>'));
  assert.ok(m, '要有 data-act="' + act + '" 的按钮：' + html);
  return m[0];
}

async function mountWithRows(rows, extra = {}) {
  const box = fakeContainer();
  const copied = [];
  const panel = mountUpdateBatchPanel(box, {
    prefix: 'life',
    call: fakeCall(rows),
    pollMs: 60000,
    autoResume: false,
    checkOnOpen: false,
    copyText: (text) => {
      copied.push(text);
    },
    ...extra,
  });
  await settled();
  return { box, copied, panel };
}

/** 集合边界用的一组行：只有 a 是真失败；busy/restart/compliant 都不算失败（与横幅同一口径）。 */
function boundaryRows() {
  return [
    rowOf({ key: 'a', title: '甲插件', pluginId: 'demo-a', error: 'install-failed', manual: 'npm i -g demo-a@2.0.0' }),
    rowOf({ key: 'busy', title: '忙占位', pluginId: 'demo-busy', error: 'update-busy' }),
    rowOf({ key: 'restart', title: '等重启', pluginId: 'demo-restart', error: 'pending-restart' }),
    rowOf({
      key: 'compliant',
      title: '合规版',
      pluginId: 'demo-compliant',
      error: 'install-failed',
      targetVersion: '2.0.0',
      snapshot: snapshotOf({
        installedVersion: '1.5.0',
        job: { state: 'completed', targetVersion: '1.5.0', message: null, requestId: 'r' },
      }),
    }),
  ];
}

// ---------- 按钮出现 / 消失 ----------

describe('#176 失败横幅：两枚批量复制按钮', () => {
  it('有失败行：横幅内、失败名单之后出现「复制诊断」「复制手工命令」', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a' })], loaded: true });
    const banner = failedBannerOf(html);
    assert.ok(banner.includes('data-act="copy-all-diag"'), '横幅里要有批量复制诊断：' + banner);
    assert.ok(banner.includes('data-act="copy-all-manual"'), '横幅里要有批量复制手工命令：' + banner);
    assert.ok(banner.includes('>复制诊断</button>'), '中文按钮文案复用既有的「复制诊断」');
    assert.ok(banner.includes('>复制手工命令</button>'), '中文按钮文案复用既有的「复制手工命令」');
    const listAt = banner.indexOf('dsh-upd-blist');
    const rowlineAt = banner.indexOf('dsh-upd-browline');
    assert.ok(listAt >= 0 && rowlineAt > listAt, '按钮行要在失败名单下方');
  });

  it('没有失败行：横幅与两枚批量按钮都不出现（排队/等重启/已装合规版也不出横幅）', () => {
    const rows = [
      rowOf({ key: 'busy', phase: 'failed', error: 'update-busy' }),
      rowOf({ key: 'restart', phase: 'failed', error: 'pending-restart' }),
      rowOf({
        key: 'compliant',
        phase: 'failed',
        snapshot: snapshotOf({
          installedVersion: '1.5.0',
          job: { state: 'completed', targetVersion: '1.5.0', message: null, requestId: 'r' },
        }),
      }),
      rowOf({ key: 'done', phase: 'done', error: null }),
    ];
    const html = renderBatchPanelHTML({ rows, loaded: true });
    assert.ok(!html.includes(FAILED_BANNER), '这些行都不算失败，不该出失败横幅');
    assert.ok(!html.includes('data-act="copy-all-diag"'), '没失败行就不画批量复制诊断');
    assert.ok(!html.includes('data-act="copy-all-manual"'), '没失败行就不画批量复制手工命令');
  });

  it('英文语言下按钮文案跟随字典（英文无中文）', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a' })], loaded: true, lang: 'en' });
    const banner = failedBannerOf(html);
    assert.ok(banner.includes('>Copy diagnostics</button>'), 'en 复制诊断');
    assert.ok(banner.includes('>Copy manual command</button>'), 'en 复制手工命令');
    assert.ok(!banner.includes('复制诊断'), 'en 横幅不混中文');
  });
});

// ---------- 失败集合口径：与横幅完全一致 ----------

describe('#176 失败集合边界：排队忙 / 等重启 / 已装合规版都不算失败', () => {
  it('batchFailedRows 只留真失败行，顺序跟行序；横幅条数与它同源', () => {
    const rows = boundaryRows();
    assert.deepEqual(
      batchFailedRows(rows).map((r) => r.key),
      ['a'],
      '只有 a 算失败',
    );
    const html = renderBatchPanelHTML({ rows, loaded: true });
    assert.ok(html.includes('1 个插件安装失败'), '横幅失败条数同一份口径：' + html.slice(0, 2000));
  });

  it('两段聚合文本都不收边界行；诊断文本带插件标识与稳定码，且不带边界行的标识', () => {
    const rows = boundaryRows();
    const diag = batchFailedDiagText(rows, 'zh');
    assert.ok(diag.includes('demo-a'), '诊断要带该行插件标识');
    assert.ok(diag.includes('install-failed'), '诊断要带稳定码');
    for (const excluded of ['demo-busy', 'demo-restart', 'demo-compliant']) {
      assert.ok(!diag.includes(excluded), '排队忙/等重启/已装合规版不进诊断：' + excluded);
    }
    const manual = batchFailedManualText(rows, 'zh');
    assert.equal(manual.text, 'npm i -g demo-a@2.0.0', '只有 a 有命令，缺失行不许混进来');
    assert.equal(manual.commands, 1);
  });
});

// ---------- 手工按钮置灰 ----------

describe('#176 手工按钮：没有一条可执行命令即置灰并说明', () => {
  it('全部失败行都没有手工命令：disabled + title=缺命令原话', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a' }), rowOf({ key: 'b', title: '乙插件' })], loaded: true });
    const banner = failedBannerOf(html);
    const manualBtn = attrsOfButton(banner, 'copy-all-manual');
    assert.ok(/\bdisabled\b/.test(manualBtn), '没有可执行命令要置灰：' + manualBtn);
    assert.ok(manualBtn.includes('title="' + ABSENT_ZH + '"'), '置灰要说清为什么：' + manualBtn);
    const diagBtn = attrsOfButton(banner, 'copy-all-diag');
    assert.ok(!/\bdisabled\b/.test(diagBtn), '诊断恒可复制，不受手工命令影响');
  });

  it('只要有一行带命令就不置灰（哪怕别的行缺命令）', () => {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ key: 'a', manual: 'npm i -g demo@2.0.0' }), rowOf({ key: 'b', title: '乙插件' })],
      loaded: true,
    });
    const manualBtn = attrsOfButton(failedBannerOf(html), 'copy-all-manual');
    assert.ok(!/\bdisabled\b/.test(manualBtn), '有命令就不该置灰：' + manualBtn);
    assert.ok(!manualBtn.includes('title='), '可复制时不挂缺命令的 title');
  });

  it('英文语言下置灰说明走英文原话', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf({ key: 'a' })], loaded: true, lang: 'en' });
    const manualBtn = attrsOfButton(failedBannerOf(html), 'copy-all-manual');
    assert.ok(manualBtn.includes('title="' + ABSENT_EN + '"'), 'en 置灰说明：' + manualBtn);
  });
});

// ---------- 复制诊断：聚合文本 ----------

describe('#176 复制诊断：全部失败行逐块拼，块间空行', () => {
  it('每行都有插件标识与稳定码、顺序跟面板一致、块间恰好一个空行、路径已脱敏', () => {
    const rows = [
      rowOf({
        key: 'a',
        pluginId: 'demo-a',
        error: 'install-failed',
        diag: { v: 1, detail: '失败在 /home/me/.dsh/profile 里' },
      }),
      rowOf({ key: 'b', pluginId: 'demo-b', error: 'check-failed' }),
      rowOf({ key: 'c', phase: 'done', error: null }),
    ];
    const text = batchFailedDiagText(rows, 'zh');
    const blocks = text.split(NL + NL);
    assert.equal(blocks.length, 2, '两个失败行 = 两块：' + JSON.stringify(text));
    assert.ok(blocks[0].includes('demo-a') && blocks[0].includes('install-failed'), '第一块是第一家：' + blocks[0]);
    assert.ok(blocks[1].includes('demo-b') && blocks[1].includes('check-failed'), '第二块是第二家：' + blocks[1]);
    assert.ok(text.indexOf('demo-a') < text.indexOf('demo-b'), '顺序与面板行序一致');
    assert.ok(text.includes('<路径>'), '本机路径要换占位符');
    assert.ok(!text.includes('/home/me'), '诊断不许带本机路径');
  });

  it('没有失败行即空串（不产出假抬头）', () => {
    assert.equal(batchFailedDiagText([rowOf({ phase: 'done', error: null })], 'zh'), '');
    assert.equal(batchFailedDiagText([], 'zh'), '');
  });
});

// ---------- 复制手工命令：聚合文本 ----------

describe('#176 复制手工命令：命令逐字 + 缺失行 # 注释', () => {
  it('有命令的行原样一行，没命令的行 # 注释占位（整段可安全粘终端）', () => {
    const manualLine = 'npm i -g demo-a@2.0.0 --registry https://registry.npmjs.org/';
    const rows = [
      rowOf({ key: 'a', title: '甲插件', manual: manualLine }),
      rowOf({ key: 'b', title: '乙插件' }),
    ];
    const out = batchFailedManualText(rows, 'zh');
    assert.equal(out.commands, 1, '有效命令行数 = 带命令的失败行数');
    const lines = out.text.split(NL);
    assert.equal(lines.length, 2, '一行一家：' + JSON.stringify(out.text));
    assert.equal(lines[0], manualLine, '命令逐字复制');
    assert.ok(lines[1].startsWith('# '), '缺失行是 # 注释行：' + lines[1]);
    assert.ok(lines[1].includes('乙插件'), '注释行要给行名');
    assert.ok(lines[1].includes('无手工命令（' + NO_SAFE_ZH + '）'), '注释行要说清为什么没有命令');
  });

  it('行名认调用方的 titles 覆盖（与面板行名同源）', () => {
    const rows = [rowOf({ key: 'b', title: '乙插件' })];
    const out = batchFailedManualText(rows, 'zh', { b: '乙（覆盖名）' });
    assert.ok(out.text.includes('乙（覆盖名）'), 'titles 覆盖要生效：' + out.text);
    assert.ok(!out.text.includes('乙插件'), '覆盖名优先于宿主 title');
  });

  it('全部有命令时 commands 等于失败行数；没有失败行即空文本', () => {
    const rows = [rowOf({ key: 'a', manual: 'npm i -g a@2.0.0' }), rowOf({ key: 'b', manual: 'npm i -g b@2.0.0' })];
    assert.deepEqual(batchFailedManualText(rows, 'zh'), {
      text: 'npm i -g a@2.0.0' + NL + 'npm i -g b@2.0.0',
      commands: 2,
    });
    assert.deepEqual(batchFailedManualText([], 'zh'), { text: '', commands: 0 });
  });
});

// ---------- 点按钮：复制出口与底部回执 ----------

describe('#176 点击两枚批量按钮：复制聚合文本并在面板底部给回执', () => {
  it('点「复制诊断」复制全部失败行诊断，回执落面板底部（不进任何一家详情）', async () => {
    const rows = [rowOf({ key: 'a', pluginId: 'demo-a' }), rowOf({ key: 'b', pluginId: 'demo-b', error: 'check-failed' })];
    const { box, copied, panel } = await mountWithRows(rows);
    await panel.act('copy-all-diag');
    assert.equal(copied.length, 1);
    assert.equal(copied[0], batchFailedDiagText(rows, 'zh'), '复制内容 = 纯函数的聚合文本');
    assert.ok(copied[0].includes('demo-b'), '复制的确实是两行');
    assert.ok(box.innerHTML.includes('<div class="dsh-upd-batch-notice"'), '回执要落面板底部');
    assert.ok(box.innerHTML.includes('已复制 2 家插件的诊断'), '回执带失败行数：' + box.innerHTML.slice(-600));
    panel.unmount();
  });

  it('点「复制手工命令」复制命令 + 注释行，回执带命令条数', async () => {
    const rows = [
      rowOf({ key: 'a', manual: 'npm i -g demo-a@2.0.0' }),
      rowOf({ key: 'b', title: '乙插件' }),
    ];
    const { box, copied, panel } = await mountWithRows(rows);
    await panel.act('copy-all-manual');
    assert.equal(copied.length, 1);
    assert.equal(copied[0], batchFailedManualText(rows, 'zh').text, '复制内容 = 纯函数的聚合文本');
    assert.ok(box.innerHTML.includes('已复制 1 条手工命令（无命令的插件已用 # 注释标注）'), '回执带命令条数：' + box.innerHTML.slice(-600));
    panel.unmount();
  });

  it('没有可执行命令时程序调用也兜底：不复制、不弹回执', async () => {
    const rows = [rowOf({ key: 'a' }), rowOf({ key: 'b', title: '乙插件' })];
    const { box, copied, panel } = await mountWithRows(rows);
    await panel.act('copy-all-manual');
    assert.equal(copied.length, 0, '只有 # 注释的文本没有复制意义');
    assert.ok(!box.innerHTML.includes('已复制'), '不弹假成功回执');
    panel.unmount();
  });

  it('en 语言下回执跟随字典（英文）', async () => {
    const rows = [rowOf({ key: 'a', pluginId: 'demo-a' }), rowOf({ key: 'b', pluginId: 'demo-b', error: 'check-failed' })];
    const { box, copied, panel } = await mountWithRows(rows, { locale: 'en' });
    await panel.act('copy-all-diag');
    assert.equal(copied.length, 1);
    assert.ok(box.innerHTML.includes('Diagnostics for 2 plugin(s) copied'), 'en 回执：' + box.innerHTML.slice(-600));
    panel.unmount();
  });
});

// ---------- 两主题：按钮成组、不隐藏（Lead 复核补） ----------

describe('#176 两主题下两枚按钮成组且不隐藏', () => {
  it('default 与 archive 都渲染两枚按钮，且被同一个成组容器包住', () => {
    for (const theme of ['default', 'archive']) {
      const html = renderBatchPanelHTML({
        rows: [rowOf({ key: 'a', manual: 'npm i -g a@2.0.0' })],
        loaded: true,
        theme,
      });
      const banner = failedBannerOf(html);
      assert.ok(banner.includes('data-act="copy-all-diag"'), theme + '：复制诊断要在');
      assert.ok(banner.includes('data-act="copy-all-manual"'), theme + '：复制手工命令要在');
      assert.ok(banner.includes('<span class="dsh-upd-bcopy">'), theme + '：两枚按钮要成组，不被 browline 的按钮右对齐规则拆开');
    }
  });

  it('成组容器靠右、组内按钮不再各自靠右（基础皮肤就成立，不靠 archive 补救）', () => {
    assert.ok(
      UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-browline>.dsh-upd-bcopy{display:inline-flex;align-items:center;gap:10px;flex:none;margin-left:auto}'),
      '成组容器靠右',
    );
    assert.ok(
      UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-browline>.dsh-upd-bcopy>button{flex:none;margin:0}'),
      '组内按钮不各自靠右',
    );
  });
});
