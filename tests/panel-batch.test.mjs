/**
 * tests/panel-batch.test.mjs —— 多目标批量面板（#25）。
 *
 * 只测外部行为/产物：挂载即查与轮询口径、一行一家的三件事（有没有事 / 是哪几家 / 我要做什么）、
 * 两个宏与忙守卫、失败与待重启的常驻横幅与行内入口、总账分类计数、双主题只换肤、
 * 详情复用单插件内核且只读、unmount 只停轮询。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BATCH_PANEL_POLL,
  UPDATE_BATCH_PANEL_CSS,
  UPDATE_BATCH_PANEL_D5_CSS,
  batchLedgerCounts,
  batchLedgerText,
  batchRowStatus,
  buildBatchPhoneNames,
  mountUpdateBatchPanel,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js'

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeContainer() {
  const listeners = []
  return {
    innerHTML: '',
    listeners,
    addEventListener(type, fn) {
      if (type === 'click') listeners.push(fn)
    },
    removeEventListener(type, fn) {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
}

/** 造一次点击：act 为空即模拟点到了单插件内核的按钮（data-action，不归批量面板管）。 */
function clickAct(box, act, key) {
  const attrs = {}
  if (act) attrs['data-act'] = act
  if (key !== undefined) attrs['data-key'] = key
  const el = { getAttribute: (name) => (name in attrs ? attrs[name] : null) }
  const target = { closest: (sel) => (sel === '[data-act]' && attrs['data-act'] ? el : null) }
  for (const fn of [...box.listeners]) fn({ target })
}

/** 批量面板的根标签（属性顺序由实现定；只在这段里找主题/形态属性，避开样式串里的同名子串）。 */
function rootTagOf(html) {
  const start = html.indexOf('<div class="dsh-upd dsh-upd-batch"')
  assert.ok(start >= 0, '应含批量面板根')
  return html.slice(start, html.indexOf('>', start))
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
  }
}

function fakeCall(rows, reply) {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (reply) return reply(name, args)
    return { ok: true, session: sessionOf(rows), rows, progress: {} }
  }
  return { call, log }
}

function mountPanel(box, rows, options = {}) {
  const { call, log } = fakeCall(rows, options.reply)
  const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, ...options })
  return { panel, log }
}

// ---------- 挂载与轮询 ----------

describe('挂载与轮询', () => {
  it('挂载即调 <prefix>.batchStatus（电话名与前缀都从参数来）', async () => {
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, [rowOf()])
    await settled()
    assert.equal(log.length, 1)
    assert.equal(log[0].name, 'life.batchStatus')
    assert.deepEqual(buildBatchPhoneNames('life'), {
      status: 'life.batchStatus',
      check: 'life.batchCheck',
      install: 'life.batchInstall',
      resume: 'life.batchResume',
      cancel: 'life.batchCancel',
    })
    panel.unmount()
  })

  it('轮询按 pollMs 复查；unmount 之后立刻停', async () => {
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, [rowOf()], { pollMs: 250 })
    await settled()
    assert.ok(log.length >= 1, '挂载即查一次')
    await sleep(600)
    const afterPoll = log.length
    assert.ok(afterPoll >= 2, '到点要再查一次，实到 ' + afterPoll)
    panel.unmount()
    await sleep(500)
    assert.equal(log.length, afterPoll, 'unmount 之后不再轮询')
  })

  it('pollMs 越界抛错（下限 250）；缺 call / prefix / 容器也当场拒绝', () => {
    assert.equal(BATCH_PANEL_POLL.defaultMs, 1500)
    assert.equal(BATCH_PANEL_POLL.minMs, 250)
    const ok = { prefix: 'life', call: async () => ({}) }
    assert.throws(() => mountUpdateBatchPanel(fakeContainer(), { ...ok, pollMs: 100 }), /250/)
    assert.throws(() => mountUpdateBatchPanel(fakeContainer(), { ...ok, pollMs: Number.NaN }), /250/)
    assert.throws(() => mountUpdateBatchPanel(fakeContainer(), { prefix: 'life', pollMs: 1000 }), /call/)
    assert.throws(() => mountUpdateBatchPanel(fakeContainer(), { call: async () => ({}) }), /prefix/)
    assert.throws(() => mountUpdateBatchPanel({}, ok), /innerHTML/)
  })
})

// ---------- 明细：一行一家 ----------

describe('明细：一行一家', () => {
  it('N 家画 N 行：灯 + 中文名 + 当前版本 → 远端版本 + 行内动作', async () => {
    const rows = [
      rowOf({ key: 'a', title: '甲插件' }),
      rowOf({ key: 'b', title: '乙插件', phase: 'current', targetVersion: null }),
      rowOf({
        key: 'c',
        title: '丙插件',
        targetVersion: '2.0.0',
        snapshot: snapshotOf({ runningVersion: '1.5.0' }),
      }),
    ]
    const box = fakeContainer()
    const { panel } = mountPanel(box, rows)
    await settled()
    const html = box.innerHTML
    assert.equal((html.match(/class="dsh-upd-brow"/g) || []).length, 3, '一行一家，恰好 N 行')
    assert.ok(html.includes('甲插件') && html.includes('乙插件') && html.includes('丙插件'))
    assert.ok(html.includes('1.0.0 → 1.2.0'), '当前版本 → 远端版本要照给')
    assert.ok(html.includes('1.5.0 → 2.0.0'), '当前版本取该家自己的运行版')
    assert.ok(html.includes('<span class="dsh-upd-updot" data-tone="todo">'), '可更新那家的灯')
    assert.ok(html.includes('data-act="row-install"'), '可更新那家有行内动作')
    panel.unmount()
  })

  it('每行一句可执行的状态词：来自 phase、是中文、不是相位英文', () => {
    const cases = {
      pending: '等它，轮到就自动查新版',
      checking: '正在查新版，稍等',
      ready: '点「装这家」装 1.2.0',
      installing: '正在安装，别动',
      current: '已是最新，不用动',
      done: '装好了，不用动',
      failed: '没装上，点「重试」再来一次',
      skipped: '这一版已跳过，不用动',
    }
    for (const [phase, word] of Object.entries(cases)) {
      const html = renderBatchPanelHTML({ rows: [rowOf({ phase })] })
      const marker = 'class="dsh-upd-bstat">'
      const at = html.indexOf(marker)
      assert.ok(at >= 0, phase + '：行上要有状态词')
      const got = html.slice(at + marker.length, html.indexOf('</span>', at))
      assert.equal(got, word, phase + ' 的状态词')
      assert.ok(!got.includes(phase), phase + ' 不许把相位英文写给人看')
      assert.equal(batchRowStatus(rowOf({ phase })), word)
    }
    const restart = renderBatchPanelHTML({ rows: [rowOf({ phase: 'done', restartRequired: true })] })
    assert.ok(restart.includes('装好了，重启宿主才生效'), '待重启要说清下一步是重启')
  })
})

// ---------- 总账与两个宏 ----------

describe('总账与两个宏', () => {
  it('顶部一行：卷宗抬头「更新档案 · 总账」+ 右侧两件按钮', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf()] })
    assert.ok(html.includes('更新档案'))
    assert.ok(html.includes('<i>总账</i>'))
    assert.ok(html.includes('>检查更新</button>'))
    assert.ok(html.includes('>全部更新</button>'))
  })

  it('「检查更新」→ batchCheck；「全部更新」→ batchInstall（不带 keys = 全部提交）', async () => {
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, [rowOf()])
    await settled()
    log.length = 0
    await panel.act('check')
    assert.equal(log.length, 1)
    assert.equal(log[0].name, 'life.batchCheck')
    log.length = 0
    await panel.act('install')
    assert.equal(log.length, 1)
    assert.equal(log[0].name, 'life.batchInstall')
    assert.deepEqual(log[0].args, {}, '全部更新不点 keys：全部提交语义')
    panel.unmount()
  })

  it('总账一行把 可更新/安装中/待重启/失败 四类数对得上', async () => {
    const rows = [
      rowOf({ key: 'a' }),
      rowOf({ key: 'b' }),
      rowOf({ key: 'c' }),
      rowOf({ key: 'd', phase: 'installing' }),
      rowOf({ key: 'e', phase: 'done', restartRequired: true }),
      rowOf({ key: 'f', phase: 'failed', error: 'install-failed' }),
    ]
    const box = fakeContainer()
    const { panel } = mountPanel(box, rows)
    await settled()
    assert.ok(
      box.innerHTML.includes('3 家可更新 · 1 家安装中 · 1 家待重启 · 1 家失败'),
      '四类数要在同一行上对齐',
    )
    const counts = batchLedgerCounts(rows)
    assert.equal(counts.updatable, 3)
    assert.equal(counts.installing, 1)
    assert.equal(counts.restart, 1)
    assert.equal(counts.failed, 1)
    assert.equal(
      counts.updatable + counts.installing + counts.pending + counts.restart + counts.failed + counts.skipped + counts.settled,
      rows.length,
      '每行恰好进一档',
    )
    assert.equal(batchLedgerText(counts).split(' · ').length, 4, '零档不占位')
    panel.unmount()
  })

  it('忙守卫：任一行 installing 时两个批量入口都置灰，没人装时才放开', async () => {
    const busyBox = fakeContainer()
    const busy = mountPanel(busyBox, [rowOf({ key: 'a', phase: 'installing' }), rowOf({ key: 'b' })])
    await settled()
    assert.match(busyBox.innerHTML, /data-act="check"[^>]*disabled/, '检查更新要禁用')
    assert.match(busyBox.innerHTML, /data-act="install"[^>]*disabled/, '全部更新要禁用')
    assert.match(busyBox.innerHTML, /data-act="row-install"[^>]*disabled/, '行内装这家也要禁用')
    assert.match(busyBox.innerHTML, /data-act="cancel"[^>]*disabled/, '安装中取消也停不了正在跑的一家，别给人假动作')
    busy.panel.unmount()

    const idleBox = fakeContainer()
    const idle = mountPanel(idleBox, [rowOf({ key: 'b' })])
    await settled()
    assert.ok(!/data-act="check"[^>]*disabled/.test(idleBox.innerHTML), '没人装时检查更新可用')
    assert.ok(!/data-act="install"[^>]*disabled/.test(idleBox.innerHTML), '没人装时全部更新可用')
    idle.panel.unmount()
  })
})

// ---------- 失败与待重启：常驻横幅 + 行内入口 ----------

describe('失败与待重启：常驻横幅 + 行内入口', () => {
  it('失败行有可见的失败提示与行内重试；点重试只推这一家', async () => {
    const rows = [rowOf({ key: 'a', title: '甲插件', phase: 'failed', error: 'install-failed' })]
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, rows)
    await settled()
    const html = box.innerHTML
    assert.ok(html.includes('install-failed'), '稳定码要露出来')
    assert.ok(html.includes('装不上（详见诊断摘要）'), '稳定码要配中文人话')
    assert.match(html, /data-act="row-install" data-key="a"[^>]*>重试</, '失败行要给行内重试')
    assert.ok(html.includes('1 家没装成'), '失败常驻横幅')
    log.length = 0
    await panel.act('row-install')
    assert.equal(log.length, 0, '没给键就不许瞎装一家')
    await panel.act('row-install', 'a')
    assert.equal(log.length, 1)
    assert.equal(log[0].name, 'life.batchInstall')
    assert.deepEqual(log[0].args, { keys: ['a'] }, '行内重试只推这一家')
    panel.unmount()
  })

  it('待重启行给「重启宿主」入口，措辞与单插件面板一致', async () => {
    const rows = [rowOf({ key: 'a', title: '甲插件', phase: 'done', restartRequired: true })]
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, rows)
    await settled()
    const html = box.innerHTML
    assert.match(html, /data-act="restart"[^>]*>重启宿主</, '待重启行要有「重启宿主」')
    assert.ok(html.includes('重启宿主，让新版跑起来；这是正常终态，不是失败。'), '与单插件面板同一措辞')
    assert.ok(html.includes('1 家已装好，重启宿主后生效。'), '待重启常驻横幅')
    const before = log.length
    await panel.act('restart')
    assert.equal(log.length, before, '重启入口不打任何电话（宿主没有重启自己的电话）')
    assert.ok(box.innerHTML.includes('本宿主未提供重启入口：请手动重启宿主'), '没给重启流程就如实说手动重启')
    panel.unmount()
  })

  it('调用方给了重启流程就交给它，不假装自己能重启', async () => {
    const box = fakeContainer()
    let called = 0
    const { call } = fakeCall([rowOf({ key: 'a', phase: 'done', restartRequired: true })])
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life',
      call,
      pollMs: 60000,
      onRestartRequested: () => {
        called += 1
      },
    })
    await settled()
    await panel.act('restart')
    assert.equal(called, 1)
    assert.ok(box.innerHTML.includes('已按调用方的重启流程处理'))
    panel.unmount()
  })

  it('失败与待重启的横幅常驻：不展开任何一行也在，且不在详情里', async () => {
    const rows = [
      rowOf({ key: 'a', phase: 'failed', error: 'check-failed' }),
      rowOf({ key: 'b', phase: 'done', restartRequired: true }),
    ]
    const box = fakeContainer()
    const { panel } = mountPanel(box, rows)
    await settled()
    const html = box.innerHTML
    assert.ok(html.includes('<div class="dsh-upd-banner" data-kind="failed"'), '失败横幅常驻')
    assert.ok(html.includes('<div class="dsh-upd-banner" data-kind="restart"'), '待重启横幅常驻')
    assert.ok(!html.includes('<div class="dsh-upd-bdetail"'), '没点开详情，横幅不许藏进抽屉')
    panel.unmount()
  })
})

// ---------- 详情：复用单插件内核，且只读 ----------

describe('详情：复用单插件内核，且只读', () => {
  it('点一行展开：详情就是单插件内核（五章编号 + 复制诊断），再点收起', async () => {
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, [rowOf({ key: 'a', title: '甲插件' })])
    await settled()
    assert.ok(!box.innerHTML.includes('<div class="dsh-upd-bdetail"'), '默认全收起')
    await panel.act('toggle-details', 'a')
    const html = box.innerHTML
    assert.ok(html.includes('<div class="dsh-upd-bdetail"'), '展开该家详情')
    const detail = html.slice(html.indexOf('<div class="dsh-upd-bdetail"'))
    assert.deepEqual(
      [...detail.matchAll(/data-chapter="(\d\d)"/g)].map((m) => m[1]),
      ['01', '02', '03', '04', '05'],
      '详情就是单插件内核那五章',
    )
    assert.ok(detail.includes('data-plugin="a"'), '详情按插件标识指向该家')
    assert.ok(detail.includes('data-act="row-copy-diag"'), '复制诊断改由批量面板自己出（真能点）')
    assert.ok(!/\bdata-action=/.test(detail), '只读内核里不许再有 data-action 按钮')
    const before = log.length
    clickAct(box, null) // 点到没有 data-act 的空处：批量面板不接这条线
    assert.equal(log.length, before)
    await panel.act('toggle-details', 'a')
    assert.ok(!box.innerHTML.includes('<div class="dsh-upd-bdetail"'), '再点收起')
    panel.unmount()
  })

  it('事件委托：点行本身也展开；点宏按钮走同一条路', async () => {
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, [rowOf({ key: 'a' })])
    await settled()
    clickAct(box, 'toggle-details', 'a')
    assert.ok(box.innerHTML.includes('<div class="dsh-upd-bdetail"'), '点行本身也展开')
    log.length = 0
    clickAct(box, 'check')
    await settled()
    assert.equal(log[0].name, 'life.batchCheck', '点宏按钮走同一条路')
    panel.unmount()
  })

  it('详情不嵌套滚动：dialog 形态下详情仍是 embedded，且 CSS 中性化 overlay 滚动', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf()], mode: 'dialog', expandedKey: 'a' })
    assert.ok(html.includes('data-mode="dialog"'), '批量面板自己是弹窗')
    assert.ok(html.includes('data-mode="embedded"'), '详情是内嵌（不叠第二层滚动壳）')
    assert.ok(
      UPDATE_BATCH_PANEL_CSS.includes('.dsh-upd-overlay .dsh-upd-bdetail .dsh-upd{max-height:none;overflow:visible}'),
      'overlay 里的详情要中性化 max-height/overflow',
    )
  })
})

// ---------- 解法三：详情只读内核 + 批量面板自己的动作行 ----------

describe('死按钮门禁：面板里每个可点按钮都得有人接', () => {
  /** 盘一遍所有按钮标签：不许 data-action（内核通道），可点的必须带 data-act 或 disabled。 */
  function assertNoDeadButtons(html, where) {
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])
    assert.ok(buttons.length > 0, where + '：总该有按钮')
    for (const tag of buttons) {
      assert.ok(!/\bdata-action=/.test(tag), where + '：不许出现内核 data-action 按钮 —— ' + tag)
      assert.ok(
        tag.includes('data-act=') || tag.includes('disabled'),
        where + '：可点的按钮必须带 data-act 或 disabled（可点没人接即失败）—— ' + tag,
      )
    }
    return buttons.length
  }

  it('各种状态组合下：没有 data-action 按钮，也没有「可点没人接」的按钮', async () => {
    // 覆盖：忙队列（内核 03 章本来会画 data-action 的队列开关）+ 手工命令 + 失败 + 待重启。
    const busyQueue = {
      busy: true,
      owner: null,
      waiting: [{ pluginId: 'other', requestId: 'r', targetVersion: '9.9.9', enqueuedAt: 1 }],
      position: 2,
    }
    const rows = [
      rowOf({
        key: 'a',
        pluginId: 'dead-button-probe',
        title: '甲插件',
        manual: 'npm i -g demo@1.2.0',
        queue: busyQueue,
      }),
      rowOf({ key: 'b', title: '乙插件', phase: 'installing' }),
      rowOf({ key: 'c', title: '丙插件', phase: 'failed', error: 'install-failed', manual: 'npm i -g c@2' }),
      rowOf({ key: 'd', title: '丁插件', phase: 'done', restartRequired: true }),
    ]
    const box = fakeContainer()
    const { panel } = mountPanel(box, rows)
    await settled()
    let count = assertNoDeadButtons(box.innerHTML, '收起态')
    for (const key of ['a', 'b', 'c', 'd']) {
      await panel.act('toggle-details', key)
      count += assertNoDeadButtons(box.innerHTML, '展开 ' + key)
      await panel.act('toggle-details', key)
    }
    await panel.act('row-skip', 'a')
    count += assertNoDeadButtons(box.innerHTML, '跳过后')
    await panel.act('toggle-details', 'a')
    count += assertNoDeadButtons(box.innerHTML, '跳过后展开')
    assert.ok(count > 8, '按钮盘点要真的跑过多轮，实到 ' + count)
    panel.unmount()
  })

  it('忙队列那行的详情里，内核的队列开关被摘掉（章节内容照留）', async () => {
    const busyQueue = {
      busy: true,
      owner: null,
      waiting: [{ pluginId: 'other', requestId: 'r', targetVersion: '9.9.9', enqueuedAt: 1 }],
      position: 2,
    }
    const box = fakeContainer()
    const { panel } = mountPanel(box, [rowOf({ key: 'a', queue: busyQueue })])
    await settled()
    await panel.act('toggle-details', 'a')
    const html = box.innerHTML
    assert.ok(!html.includes('toggle-queue'), '内核队列开关要摘掉（可点没人接）')
    assert.ok(html.includes('>正在安装<'), '队列章节的内容照留')
    panel.unmount()
  })
})

describe('详情动作行：与行内同一通道', () => {
  it('详情里「装 X.Y.Z」与行内「装这家」打到同一个电话、同一个 key', async () => {
    const rows = [rowOf({ key: 'a', title: '甲插件', targetVersion: '2.4.0' })]
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, rows)
    await settled()
    await panel.act('toggle-details', 'a')
    const html = box.innerHTML
    const rowButton = html.match(/<button type="button" data-act="row-install" data-key="a"[^>]*>装这家<\/button>/)
    const detailButton = html.match(/<button type="button" data-act="row-install" data-key="a"[^>]*>装 2\.4\.0<\/button>/)
    assert.ok(rowButton, '行内要有「装这家」')
    assert.ok(detailButton, '详情里要有「装 2.4.0」')
    const attrsOf = (tag) => tag.slice(0, tag.indexOf('>'))
    assert.equal(attrsOf(detailButton[0]), attrsOf(rowButton[0]), '两颗按钮走的同一条通道（属性逐字相同）')
    log.length = 0
    clickAct(box, 'row-install', 'a')
    await settled()
    assert.equal(log.length, 1)
    assert.equal(log[0].name, 'life.batchInstall')
    assert.deepEqual(log[0].args, { keys: ['a'] }, '同一个 key：只推这一家')
    panel.unmount()
  })

  it('失败行的详情给「重试」；没手工命令就不画那颗「复制手工命令」', async () => {
    const box = fakeContainer()
    const { panel } = mountPanel(box, [rowOf({ key: 'a', phase: 'failed', error: 'check-failed' })])
    await settled()
    await panel.act('toggle-details', 'a')
    const start = box.innerHTML.indexOf('<span class="dsh-upd-bdetail-actions"')
    const actions = box.innerHTML.slice(start, box.innerHTML.indexOf('</span>', start))
    assert.ok(actions.includes('>重试</button>'), '失败行的详情给重试')
    assert.ok(!actions.includes('row-copy-manual'), '没有手工命令就不画复制手工命令')
    assert.ok(actions.includes('data-act="row-copy-diag"'), '复制诊断恒在')
    panel.unmount()
  })

  it('任一行 installing 时，详情里的动作与行内一起置灰', async () => {
    const rows = [rowOf({ key: 'a' }), rowOf({ key: 'b', phase: 'installing' })]
    const box = fakeContainer()
    const { panel } = mountPanel(box, rows)
    await settled()
    await panel.act('toggle-details', 'a')
    const start = box.innerHTML.indexOf('<span class="dsh-upd-bdetail-actions"')
    const actions = box.innerHTML.slice(start, box.innerHTML.indexOf('</span>', start))
    assert.ok(actions.includes('data-act="row-install"'), '详情里有装这家')
    assert.match(actions, /data-act="row-install"[^>]*disabled/, '详情动作要置灰')
    assert.match(actions, /data-act="row-skip"[^>]*disabled/, '跳过也要置灰')
    assert.match(actions, /data-act="row-copy-diag"[^>]*disabled/, '复制诊断也要置灰')
    panel.unmount()
  })

  it('复制手工命令逐字相同；复制诊断含稳定码且已脱敏', async () => {
    const copied = []
    const manual = 'npm i -g demo@2.0.0 --registry https://registry.npmjs.org/'
    const rows = [
      rowOf({
        key: 'a',
        pluginId: 'demo',
        phase: 'failed',
        error: 'install-failed',
        manual,
        diag: { v: 1, stage: 'exec', detail: '失败在 /home/me/.dsh/profile 里' },
      }),
    ]
    const box = fakeContainer()
    const { call } = fakeCall(rows)
    const panel = mountUpdateBatchPanel(box, {
      prefix: 'life',
      call,
      pollMs: 60000,
      copyText: (text) => {
        copied.push(text)
      },
    })
    await settled()
    await panel.act('toggle-details', 'a')
    await panel.act('row-copy-manual', 'a')
    assert.equal(copied.length, 1)
    assert.equal(copied[0], manual, '手工命令逐字复制')
    await panel.act('row-copy-diag', 'a')
    assert.equal(copied.length, 2)
    assert.ok(copied[1].includes('install-failed'), '诊断带稳定码')
    assert.ok(copied[1].includes('demo'), '诊断带插件标识')
    assert.ok(copied[1].includes('<路径>'), '本机路径要换成占位符')
    assert.ok(!copied[1].includes('/home/me'), '诊断不许带本机路径')
    assert.ok(box.innerHTML.includes('诊断已复制'), '复制后在该家详情里给回执')
    panel.unmount()
  })
})

describe('跳过语义：与单插件面板同一套（按插件 + 版本）', () => {
  const statOf = (html) => {
    const at = html.indexOf('class="dsh-upd-bstat">')
    return html.slice(at + 'class="dsh-upd-bstat">'.length, html.indexOf('</span>', at))
  }

  it('跳过 → 状态词变「已跳过 X.Y.Z」并给恢复；恢复后回原状', async () => {
    const rows = [rowOf({ key: 'a', pluginId: 'skip-probe', title: '甲插件', targetVersion: '2.4.0' })]
    const box = fakeContainer()
    const { panel } = mountPanel(box, rows)
    await settled()
    assert.equal(statOf(box.innerHTML), '点「装这家」装 2.4.0')
    await panel.act('row-skip', 'a')
    assert.equal(statOf(box.innerHTML), '已跳过 2.4.0', '跳过后状态词要说已跳过')
    assert.match(box.innerHTML, /data-act="row-resume-skip"[^>]*>恢复（2\.4\.0）</, '跳过后要给恢复入口')
    assert.ok(!box.innerHTML.includes('>装这家</button>'), '跳过后行内不再给装这家')
    await panel.act('toggle-details', 'a')
    assert.ok(box.innerHTML.includes('data-chapter="01"'), '详情照画五章')
    assert.ok(box.innerHTML.includes('data-act="row-resume-skip"'), '详情里也给恢复')
    assert.ok(!box.innerHTML.includes('data-act="row-skip"'), '跳过后详情里不再给跳过')
    await panel.act('row-resume-skip', 'a')
    assert.equal(statOf(box.innerHTML), '点「装这家」装 2.4.0', '恢复后回原状')
    panel.unmount()
  })

  it('跳过按 (插件, 版本) 记：同一家换个新版本照样提醒', async () => {
    const rows = [rowOf({ key: 'a', pluginId: 'skip-probe-2', targetVersion: '2.4.0' })]
    const box = fakeContainer()
    const { panel } = mountPanel(box, rows)
    await settled()
    await panel.act('row-skip', 'a')
    assert.equal(statOf(box.innerHTML), '已跳过 2.4.0')
    rows[0].targetVersion = '3.0.0'
    await panel.refresh()
    assert.equal(statOf(box.innerHTML), '点「装这家」装 3.0.0', '换一版即重新提醒')
    panel.unmount()
  })
})

// ---------- 双主题 ----------

describe('双主题：默认最小，d5-paper 只换肤', () => {
  it('不传即最小默认：没有 data-theme、没有 d5 串', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf()] })
    assert.ok(html.includes('class="dsh-upd dsh-upd-batch"'), '沿用 dsh-upd-* 前缀')
    assert.ok(!rootTagOf(html).includes('data-theme='), '默认不许挂 data-theme')
    assert.ok(!html.includes('d5-paper'), '默认不许带 D5 串')
  })

  it('d5-paper 走 data-theme 属性，并在同前缀下换肤', () => {
    const html = renderBatchPanelHTML({ rows: [rowOf()], theme: 'd5-paper' })
    assert.ok(rootTagOf(html).includes('data-theme="d5-paper"'), 'D5 靠根上的 data-theme 属性')
    assert.ok(html.includes('--d5-serif'), 'D5 皮肤串要在')
    assert.ok(UPDATE_BATCH_PANEL_D5_CSS.includes('[data-theme="d5-paper"]'), '批量皮肤的 D5 段也按属性收敛')
    assert.ok(!UPDATE_BATCH_PANEL_CSS.includes('d5-paper'), '默认那串不许混进 D5')
  })

  it('setTheme 现场切换；非法主题/形态当场抛错', async () => {
    const box = fakeContainer()
    const { panel } = mountPanel(box, [rowOf()])
    await settled()
    assert.ok(!rootTagOf(box.innerHTML).includes('data-theme='))
    panel.setTheme('d5-paper')
    assert.ok(rootTagOf(box.innerHTML).includes('data-theme="d5-paper"'))
    panel.setTheme('default')
    assert.ok(!rootTagOf(box.innerHTML).includes('data-theme='))
    assert.throws(() => panel.setTheme('d5'), /主题/)
    assert.throws(() => panel.setMode('popup'), /形态/)
    panel.setMode('dialog')
    assert.ok(rootTagOf(box.innerHTML).includes('data-mode="dialog"'))
    panel.unmount()
  })
})

// ---------- 断点续跑、取消与卸载 ----------

describe('断点续跑、取消与卸载', () => {
  it('会话没进终态才给「接着上次/取消这一批」；点了各打各的电话', async () => {
    const rows = [rowOf({ key: 'a', phase: 'pending' }), rowOf({ key: 'b' })]
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, rows)
    await settled()
    assert.ok(box.innerHTML.includes('data-act="resume"'), '停住了要给续跑入口')
    assert.ok(box.innerHTML.includes('data-act="cancel"'), '没进终态要给取消入口')
    log.length = 0
    await panel.act('resume')
    assert.equal(log.length, 1)
    assert.equal(log[0].name, 'life.batchResume')
    log.length = 0
    await panel.act('cancel')
    assert.equal(log.length, 1)
    assert.equal(log[0].name, 'life.batchCancel')
    assert.ok(box.innerHTML.includes('已取消这一批'), '取消后给一句回执')
    panel.unmount()
  })

  it('全部收尾后不再给续跑/取消入口', async () => {
    const box = fakeContainer()
    const { panel } = mountPanel(box, [rowOf({ key: 'a', phase: 'done' })])
    await settled()
    assert.ok(!box.innerHTML.includes('data-act="resume"'))
    assert.ok(!box.innerHTML.includes('data-act="cancel"'))
    panel.unmount()
  })

  it('unmount 只停轮询：不发安装/取消电话，之后的 refresh/act 都是空操作', async () => {
    const box = fakeContainer()
    const { panel, log } = mountPanel(box, [rowOf({ key: 'a', phase: 'installing' })], { pollMs: 250 })
    await settled()
    const before = log.length
    assert.ok(before >= 1)
    panel.unmount()
    await panel.act('install')
    await panel.act('cancel')
    await panel.refresh()
    await sleep(500)
    assert.equal(log.length, before, '卸载后不许再打电话')
    assert.ok(!log.some((e) => e.name.endsWith('.batchInstall')), '卸载不装东西')
    assert.ok(!log.some((e) => e.name.endsWith('.batchCancel')), '卸载不取消')
    assert.equal(box.listeners.length, 0, '监听要拆掉')
  })
})

// ---------- 回包宽容读 ----------

describe('回包宽容读', () => {
  it('宿主回 ok:false 时给红条与稳定码，表照旧留着', async () => {
    const rows = [rowOf({ key: 'a', title: '甲插件' })]
    const box = fakeContainer()
    let failNext = false
    const { call } = fakeCall(rows, () => {
      if (failNext) return { ok: false, error: 'busy', errorKind: 'update-busy' }
      return { ok: true, session: sessionOf(rows), rows, progress: {} }
    })
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000 })
    await settled()
    assert.ok(box.innerHTML.includes('甲插件'))
    failNext = true
    await panel.act('check')
    assert.ok(box.innerHTML.includes('update-busy'), '稳定码要露出来')
    assert.ok(box.innerHTML.includes('同一使用范围正在装另一个'), '稳定码配中文人话')
    assert.ok(box.innerHTML.includes('甲插件'), '读失败也不许把表清空')
    panel.unmount()
  })

  it('坏行丢弃；rows 缺失时按会话账本补行（认不出的相位按 pending）', async () => {
    const rows = [rowOf({ key: 'j1', title: '甲插件' }), rowOf({ key: 'j2', phase: 'nonsense' })]
    const withRows = fakeContainer()
    const first = mountPanel(withRows, rows, {
      reply: () => ({ ok: true, session: sessionOf(rows), rows: [rows[0], { title: '没有键' }, 42], progress: {} }),
    })
    await settled()
    assert.equal((withRows.innerHTML.match(/class="dsh-upd-brow"/g) || []).length, 1, '没有稳定键的坏行丢弃')
    assert.ok(withRows.innerHTML.includes('甲插件'))
    first.panel.unmount()

    const noRows = fakeContainer()
    const second = mountPanel(noRows, rows, {
      reply: () => ({ ok: true, session: sessionOf(rows), progress: {} }),
    })
    await settled()
    assert.equal((noRows.innerHTML.match(/class="dsh-upd-brow"/g) || []).length, 2, 'rows 缺失按账本补')
    assert.ok(noRows.innerHTML.includes('等它，轮到就自动查新版'), '认不出的相位按 pending 处理')
    second.panel.unmount()
  })
})
