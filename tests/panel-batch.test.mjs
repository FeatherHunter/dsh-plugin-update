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
    assert.ok(detail.includes('data-plugin="甲插件"'), '详情指向该家')
    assert.ok(detail.includes('data-action="copy-diag"'), '内核的复制诊断也在')
    const before = log.length
    clickAct(box, null) // 点到内核按钮（data-action）：批量面板不接这条线，详情只读
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
