/**
 * tests/panel-prototype-skeleton.test.mjs —— 照原型 d5-paper.html 的档案骨架（Stage 2）。
 *
 * 只测外部行为/产物：
 *   ① 五章编号恒在且顺序为 01..05（不许跳号——现场就是 02→04→05 跳号）；
 *   ② 档案头显示「使用范围」真值 + profile 牌，缺值显示「未知」不猜；
 *   ③ 版本条三格（运行/磁盘/远端）；
 *   ④ 安装中才有进度条；已跳过才有虚框 tag；
 *   ⑤ 使用范围从宿主 includeEnv 来，调用方显式传的优先；
 *   ⑥ 卷宗抬头、状态行 27px、队列两行键值（2026-10-04 视觉定案）。
 * 以及宿主侧：includeEnv 才带 env 键，老调用回包形状一字不变。
 */
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UPDATE_PANEL_CSS, UPDATE_PANEL_D5_CSS, mountUpdatePanel, renderUpdatePanelHTML } from '../dist/panel.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-plugin'
const REGISTRY = 'https://registry.npmjs.org/'

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

function inputFor(viewOverrides = {}, renderOverrides = {}) {
  return {
    snapshot: baseSnapshot(),
    manual: null,
    queue: baseQueue(),
    skippedLatest: false,
    lastError: null,
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
    mode: 'embedded',
    ...viewOverrides,
    ...renderOverrides,
  }
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

describe('档案骨架：五章恒在、编号不跳', () => {
  it('五种状态都画 01..05，顺序不乱', () => {
    const cases = {
      update: inputFor(),
      fresh: inputFor({ snapshot: baseSnapshot({ latestVersion: null, canInstall: false }) }),
      failed: inputFor({
        snapshot: baseSnapshot({ job: { id: 'j', state: 'failed', targetVersion: '1.1.0', message: 'install-failed: x', requestId: 'r' } }),
      }),
      restart: inputFor({ snapshot: baseSnapshot({ canInstall: false, blockedReason: 'pending-restart', installedVersion: '1.1.0' }) }),
      skipped: inputFor({ skippedLatest: true }),
    }
    for (const [name, input] of Object.entries(cases)) {
      const html = renderUpdatePanelHTML(input)
      const found = [...html.matchAll(/data-chapter="(\d\d)"/g)].map((m) => m[1])
      assert.deepEqual(found, ['01', '02', '03', '04', '05'], `${name}：五章必须齐且按序`)
      for (const title of ['检查与安装', '更新日志', '更新队列', '错误信息', '手工命令']) {
        assert.ok(html.includes(title), `${name}：缺章节标题 ${title}`)
      }
    }
  })
})

describe('档案头：使用范围是真值，缺了显示未知', () => {
  it('给了 profileName 就照实显示，并挂 profile 牌', () => {
    const html = renderUpdatePanelHTML(inputFor({}, { profileName: 'desktop' }))
    assert.ok(html.includes('使用范围 <b>desktop</b>'), '须显示使用范围真值')
    assert.ok(html.includes('dsh-upd-proftag'), '须有 profile 牌')
  })

  it('没给就显示未知，绝不猜成 web/desktop', () => {
    const html = renderUpdatePanelHTML(inputFor())
    assert.ok(html.includes('使用范围 <b>未知</b>'), '缺值须显示未知')
    assert.ok(!html.includes('使用范围 <b>web</b>'), '不许猜 web')
    assert.ok(!html.includes('使用范围 <b>desktop</b>'), '不许猜 desktop')
  })
})

describe('版本条与进度条、跳过行', () => {
  it('版本条三格：运行 / 磁盘 / 远端', () => {
    const html = renderUpdatePanelHTML(inputFor())
    for (const k of ['运行', '磁盘', '远端']) assert.ok(html.includes(`>${k}</span>`), `版本条缺「${k}」格`)
    assert.ok(html.includes('1.1.0'), '远端版须进版本条')
  })

  it('只有安装中/校验中才有进度条', () => {
    const installing = renderUpdatePanelHTML(
      inputFor({ snapshot: baseSnapshot({ canInstall: false, job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' } }) }),
    )
    assert.ok(installing.includes('role="progressbar"'), '安装中须有进度条')
    const verifying = renderUpdatePanelHTML(
      inputFor({ snapshot: baseSnapshot({ canInstall: false, job: { id: 'j', state: 'verifying', targetVersion: '1.1.0', message: null, requestId: 'r' } }) }),
    )
    assert.ok(verifying.includes('role="progressbar"'), '校验中须有进度条')
    const idle = renderUpdatePanelHTML(inputFor())
    assert.ok(!idle.includes('role="progressbar"'), '空闲不该有进度条')
  })

  it('已跳过这一版才画虚框 tag', () => {
    const skipped = renderUpdatePanelHTML(inputFor({ skippedLatest: true }))
    assert.ok(skipped.includes('class="dsh-upd-tag"'), '已跳过须有虚框 tag 元素')
    assert.ok(skipped.includes('已跳过 1.1.0'), 'tag 须写明跳过的版本')
    const idle = renderUpdatePanelHTML(inputFor())
    assert.ok(!idle.includes('class="dsh-upd-tag"'), '没跳过就不该有 tag 元素（CSS 里的类名不算）')
  })
})

describe('使用范围从宿主 includeEnv 来', () => {
  it('面板自动要 includeEnv，并把宿主回的 profileName 显示出来', async () => {
    const box = fakeContainer()
    const seen = []
    const call = async (name, args) => {
      seen.push({ name, args })
      if (name.endsWith('.updateStatus')) {
        return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue(), env: { profileName: 'desktop', environmentKind: 'cli' } }
      }
      return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null }
    }
    const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 'wf', call, pollMs: 60000 })
    await panel.refresh()
    assert.equal(seen[0].args.includeEnv, true, '面板须主动要使用范围（includeEnv）')
    assert.ok(box.innerHTML.includes('使用范围 <b>desktop</b>'), '宿主回的范围名须显示出来')
    panel.unmount()
  })

  it('调用方显式传的 profileName 优先于宿主回的', async () => {
    const box = fakeContainer()
    const call = async (name) => {
      if (name.endsWith('.updateStatus')) {
        return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue(), env: { profileName: 'desktop', environmentKind: 'cli' } }
      }
      return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null }
    }
    const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 'wf', call, pollMs: 60000, profileName: 'web' })
    await panel.refresh()
    assert.ok(box.innerHTML.includes('使用范围 <b>web</b>'), '显式传的优先')
    panel.unmount()
  })
})

function fakeFetch() {
  return async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        name: TARGET,
        version: '2.0.0',
        engines: { node: '>=22' },
        dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-2.0.0.tgz`, integrity: 'sha512-' + 'A'.repeat(86) + '==' },
      }),
  })
}

function makeHost() {
  let job = null
  let locked = null
  return createHostUpdate(
    {
      readerOverrides: {
        runningVersion: '1.0.0',
        profileDir: 'C:\\fake\\profile',
        profileName: 'web',
        homeDir: 'C:\\fake\\home',
        fetchImpl: fakeFetch(),
        now: () => 1_000_000,
        randomId: () => 'id-1',
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        readInstalled: async () => ({
          profileName: 'web',
          environmentKind: 'cli',
          homeDir: 'C:\\fake\\home',
          profileDir: 'C:\\fake\\profile',
          installedVersion: '1.0.0',
          packageValid: true,
          sourceInstall: false,
          blockedReason: null,
          installationKey: 'k',
          eligible: true,
        }),
        readJob: async () => job,
        writeJob: async (v) => {
          job = v
        },
        tryAcquireLock: async (id) => {
          if (locked !== null) return false
          locked = id
          return true
        },
        releaseLock: async (id) => {
          if (locked === id) locked = null
        },
        backupJob: async () => {},
        runInstall: async () => {},
      },
    },
    { pluginId: TARGET, prefix: 'demo' }
  )
}

describe('宿主：includeEnv 才带使用范围，老调用形状不变', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })

  it('带 includeEnv 时回 env（只给范围名与宿主种类，不给路径）', async () => {
    const host = makeHost()
    const out = await host.handlers['demo.updateStatus']({ includeEnv: true })
    assert.equal(out.ok, true)
    assert.deepEqual(out.env, { profileName: 'web', environmentKind: 'cli' })
    assert.ok(!JSON.stringify(out.env).includes('C:'), '使用范围一栏不得带本机路径')
  })

  it('不带 includeEnv 时回包一字不变（没有 env 键）', async () => {
    const host = makeHost()
    const out = await host.handlers['demo.updateStatus']({})
    assert.equal(out.ok, true)
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'env'), '老调用不得多出 env 键')
  })
})

// ---------- 2026-10-04 视觉定案三件：卷宗抬头 / 状态行 27px / 队列两行键值 ----------

describe('卷宗抬头：两主题同一份内核，默认主题不显示', () => {
  it('默认主题内核里也有抬头节点，但默认 CSS 不显示；D5 才显示', () => {
    const html = renderUpdatePanelHTML(inputFor())
    assert.ok(html.includes('dsh-upd-masthead-title'), '内核须有卷宗抬头')
    assert.ok(html.includes('更新档案 <i>卷</i>'), '抬头文案须是「更新档案 卷」')
    assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-masthead{display:none}'), '默认主题须不显示抬头')
    assert.ok(UPDATE_PANEL_D5_CSS.includes('.dsh-upd-masthead{display:block'), 'D5 须显示抬头')
  })

  it('两个主题从根到横幅之前逐字同一份（皮肤只决定画不画）', () => {
    // 从根标签**之后**切起：根上的 data-theme 本来就该不一样，比的是它到横幅之间的内核。
    const cut = (h) => h.slice(h.indexOf('>', h.indexOf('<div class="dsh-upd"')) + 1, h.indexOf('<div class="dsh-upd-banner"'))
    assert.equal(cut(renderUpdatePanelHTML(inputFor({}, { theme: 'd5-paper' }))), cut(renderUpdatePanelHTML(inputFor())), '抬头与档案头两主题必须逐字相同')
  })

  it('抬头里没有主题切换按钮（用户口径：那排按钮不重要）', () => {
    const html = renderUpdatePanelHTML(inputFor({}, { theme: 'd5-paper' }))
    const head = html.slice(html.indexOf('dsh-upd-masthead'), html.indexOf('dsh-upd-head'))
    assert.ok(!head.includes('<button'), '抬头里不该有按钮')
    assert.ok(!head.includes('跟随系统'), '不搬主题切换按钮')
  })
})

describe('尺寸定案：状态行 27px、横幅不再给印章留位', () => {
  it('D5 串里状态行 27px；横幅不写 124px，档案头的 120px 仍在', () => {
    assert.ok(UPDATE_PANEL_D5_CSS.includes('font-size:27px'), '状态行须照原型 .status-line=27px')
    assert.ok(!UPDATE_PANEL_D5_CSS.includes('padding-right:124px'), '横幅不许再留 124px 印章位（实测白留，还把 27px 挤成两行）')
    assert.ok(UPDATE_PANEL_D5_CSS.includes('padding-right:120px'), '档案头的印章占位须保留（那里真的重叠）')
    assert.ok(!UPDATE_PANEL_D5_CSS.includes('white-space:nowrap'), '窄屏不许再 nowrap（27px 在窄容器里必须能折行）')
  })
})

describe('队列定案：两行键值 + 开关挪到 03 章标题行右端', () => {
  const busyQueue = {
    busy: true,
    owner: { pluginId: null, busy: true },
    waiting: [{ pluginId: 'p', requestId: 'mine', targetVersion: '1.1.0', enqueuedAt: 1 }],
    position: 2,
  }

  it('开关在标题行里，正文里不再有开关', () => {
    const html = renderUpdatePanelHTML(inputFor({ queue: busyQueue }))
    const ch3 = html.slice(html.indexOf('data-chapter="03"'))
    const head = ch3.slice(0, ch3.indexOf('</div>'))
    assert.ok(head.includes('data-action="toggle-queue"'), '开关须在 03 章标题行里')
    assert.ok(head.includes('dsh-upd-chap-note'), '开关须挂 chap-note 落在标题行右端')
    const body = ch3.slice(ch3.indexOf('dsh-upd-queue'), ch3.indexOf('</section>'))
    assert.ok(!body.includes('toggle-queue'), '正文里不该再有开关')
  })

  it('正文是两行键值：正在安装 / 你的顺位，顺位与前方数照给', () => {
    const html = renderUpdatePanelHTML(inputFor({ queue: busyQueue }))
    assert.ok(html.includes('>正在安装<'), '须有「正在安装」一行')
    assert.ok(html.includes('>你的顺位<'), '须有「你的顺位」一行')
    assert.match(html, /第 2 位/, '顺位照给')
    assert.match(html, /前方 1 个/, '前方人数照给')
  })

  it('默认不露他人标识与版本；showOthers 打开才露，并多一行排队顺序', () => {
    const raw = {
      busy: true,
      owner: { pluginId: 'other-plugin', jobId: 'j', requestId: 'r', targetVersion: '9.9.9', startedAt: 1 },
      waiting: [{ pluginId: 'other-plugin', requestId: 'r2', targetVersion: '9.9.9', enqueuedAt: 1 }],
      position: null,
    }
    const hidden = renderUpdatePanelHTML(inputFor({ queue: raw }))
    assert.ok(!hidden.includes('other-plugin'), '默认不许印他人标识')
    assert.ok(!hidden.includes('9.9.9'), '默认不许印他人版本')
    const shown = renderUpdatePanelHTML(inputFor({ queue: raw, showOthers: true }))
    assert.ok(shown.includes('other-plugin'), 'showOthers 打开才露他人标识')
    assert.ok(shown.includes('>排队顺序<'), '开关打开要有东西可看（排队顺序一行）')
  })

  it('没排队时仍是中性一句话，不画两行键值', () => {
    const html = renderUpdatePanelHTML(inputFor())
    assert.ok(!html.includes('<div class="dsh-upd-qrow"'), '空闲不该画队列行（CSS 里的类名不算）')
    assert.ok(html.includes('当前没有排队任务'), '空闲须给中性提示')
  })
})

// ---------- 只读渲染（actions: 'none'）：给「调用方自己提供动作面」的场景 ----------

describe('只读渲染：内容一字不减，动作按钮一个不留', () => {
  it('actions:none 时不出现任何 data-action 按钮', () => {
    const html = renderUpdatePanelHTML(inputFor({}, { actions: 'none' }))
    assert.ok(!html.includes('data-action='), '只读渲染不许出现任何动作按钮（死按钮的根治手段）')
    assert.ok(!html.includes('<button'), '只读渲染下不该有 button 元素')
  })

  it('actions:none 时五章与版本条照画（内容一字不减）', () => {
    const html = renderUpdatePanelHTML(inputFor({}, { actions: 'none' }))
    const found = [...html.matchAll(/data-chapter="(\d\d)"/g)].map((m) => m[1])
    assert.deepEqual(found, ['01', '02', '03', '04', '05'], '五章仍须齐且按序')
    for (const k of ['运行', '磁盘', '远端']) assert.ok(html.includes('>' + k + '</span>'), '版本条缺「' + k + '」')
    assert.ok(html.includes('检查与安装'), '章节标题仍在')
  })

  it('不传 actions 即现状（动作行照画，老调用一字不动）', () => {
    const html = renderUpdatePanelHTML(inputFor())
    assert.ok(html.includes('data-action="check"'), '默认仍画查新版')
    assert.ok(html.includes('data-action="install"'), '默认仍画安装')
    assert.ok(html.includes('data-action="copy-diag"'), '默认仍画复制诊断')
  })

  it('只读渲染连队列开关一起摘掉（动作面一处都不许漏）', () => {
    const busyQueue = {
      busy: true,
      owner: { pluginId: null, busy: true },
      waiting: [{ pluginId: 'p', requestId: 'mine', targetVersion: '1.1.0', enqueuedAt: 1 }],
      position: 2,
    }
    const html = renderUpdatePanelHTML(inputFor({ queue: busyQueue }, { actions: 'none' }))
    assert.ok(!html.includes('data-action='), '忙队列下也不许漏出 toggle-queue 按钮（实测漏过一次）')
    assert.ok(!html.includes('<button'), '只读渲染下不该有 button 元素')
    assert.ok(html.includes('你的顺位'), '队列内容照画')
    const normal = renderUpdatePanelHTML(inputFor({ queue: busyQueue }))
    assert.ok(normal.includes('data-action="toggle-queue"'), '默认渲染仍给队列开关')
  })

  it('只读渲染下进度条与「已跳过」提示照画（它们不是动作）', () => {
    const installing = renderUpdatePanelHTML(
      inputFor({ snapshot: baseSnapshot({ canInstall: false, job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' } }) }, { actions: 'none' }),
    )
    assert.ok(installing.includes('role="progressbar"'), '进度条须照画')
    const skipped = renderUpdatePanelHTML(inputFor({ skippedLatest: true }, { actions: 'none' }))
    assert.ok(skipped.includes('已跳过 1.1.0'), '已跳过提示须照画')
  })
})
