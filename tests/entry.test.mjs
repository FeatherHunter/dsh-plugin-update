/**
 * tests/entry.test.mjs —— 更新入口件（#25）。
 *
 * 只测外部行为：挂上、点一下、看容器里的 HTML、看打电话记录、看 label()。
 * 传输与容器全用假件，不碰真机、不真联网、不真装。
 * 铁律「任何路径都不自动安装」写成负向断言：整个生命周期里没有 .updateInstall 调用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryLabelFor, mountUpdateEntry } from '../dist/entry.js'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

function baseQueue() {
  return { busy: false, owner: null, waiting: [], position: null }
}

/** 宿主侧只读状态的回包。 */
function statusReply(snapshot, extra = {}) {
  return { ok: true, snapshot, manual: null, receipt: null, queue: baseQueue(), ...extra }
}

/** 宿主侧查新版的回包（带检查凭证，但入口件不用它——安装只从面板走）。 */
function checkReply(snapshot, extra = {}) {
  return {
    ok: true,
    snapshot,
    manual: null,
    receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 999 },
    queue: baseQueue(),
    ...extra,
  }
}

/** 已是最新：远端版本等于运行版本，且不许装。 */
const UP_TO_DATE = baseSnapshot({ latestVersion: '1.0.0', canInstall: false })

/** 假传输：按电话名回剧本（剧本可以是值，也可以是函数），并记下每一次调用。 */
function fakeCall(script = {}) {
  const log = []
  const pick = (s, fallback) => (typeof s === 'function' ? s(log) : s === undefined ? fallback : s)
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) return pick(script.status, statusReply(baseSnapshot()))
    if (name.endsWith('.updateCheck')) return pick(script.check, checkReply(baseSnapshot()))
    if (name.endsWith('.updateInstall')) return pick(script.install, statusReply(baseSnapshot()))
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

/**
 * 假容器：只要 innerHTML 与事件能力（与 panel 的容器契约同一口径，所以入口件不许要求 querySelector）。
 * click() 模拟一次点击：传被点元素的属性表，closest 只认属性选择器（[attr] / [attr="值"]，与 DOM 同口径）；
 * 派发中被拆掉的监听不再触发（与 DOM 同口径）。
 */
function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== listener))
    },
    click(attrs) {
      const matches = (sel) => {
        const m = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel)
        if (!m) return false
        if (!Object.prototype.hasOwnProperty.call(attrs, m[1])) return false
        return m[2] === undefined || attrs[m[1]] === m[2]
      }
      const target = {
        closest: (sel) => (matches(sel) ? { getAttribute: (name) => attrs[name] ?? null } : null),
      }
      for (const listener of [...(listeners.get('click') ?? [])]) {
        if (!(listeners.get('click') ?? []).includes(listener)) continue
        listener({ target })
      }
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length
    },
  }
}

const CLICK_ENTRY = { 'data-dsh-upd-entry': 'activate' }
const CLICK_CLOSE = { 'data-action': 'close-view' }

async function settled() {
  await new Promise((r) => setTimeout(r, 10))
}

// ---------- 默认形态：一个按钮，进来只读查一次 ----------

test('默认挂上就是一个按钮：挂载即静默查一次状态（只读），文案是「检查更新」', async () => {
  const { call, log } = fakeCall({ status: statusReply(UP_TO_DATE) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 60000 })
  assert.match(box.innerHTML, /<button[^>]*data-dsh-upd-entry="activate"/, '挂上就是一个按钮')
  assert.match(box.innerHTML, /检查更新/, '未查/无新版都是「检查更新」')
  assert.equal(entry.label(), '检查更新')
  await settled()
  assert.deepEqual(log.map((e) => e.name), ['p.updateStatus'], 'autoCheck=mount 只调 .updateStatus（只读本地、不联网）')
  assert.match(box.innerHTML, /data-state="idle"/, '状态如实带到 DOM 上')
  entry.unmount()
})

test('电话名只从前缀派生：传 notes 就是 notes.*，不传就是默认 wf', async () => {
  const a = fakeCall({ status: statusReply(UP_TO_DATE) })
  const entryA = mountUpdateEntry(fakeContainer(), { pluginId: 'p', prefix: 'notes', call: a.call, pollMs: 60000 })
  await entryA.refresh()
  assert.ok(a.log.some((e) => e.name === 'notes.updateStatus'), '前缀进电话名')
  assert.ok(!a.log.some((e) => e.name.startsWith('wf.')), '传了前缀就不该再出现默认前缀')
  entryA.unmount()

  const b = fakeCall({ status: statusReply(UP_TO_DATE) })
  const entryB = mountUpdateEntry(fakeContainer(), { pluginId: 'p', call: b.call, pollMs: 60000 })
  await entryB.refresh()
  assert.ok(b.log.some((e) => e.name === 'wf.updateStatus'), '不传前缀走冻结默认值')
  entryB.unmount()
})

// ---------- 状态文案：由快照推出来，是可执行的人话 ----------

test('状态文案五档各不相同，且是人话不是稳定码', () => {
  const cases = [
    ['未查', null, '检查更新'],
    ['无新版', { snapshot: UP_TO_DATE, error: null }, '检查更新'],
    ['有新版', { snapshot: baseSnapshot(), error: null }, '有新版 1.1.0'],
    [
      '安装中',
      { snapshot: baseSnapshot({ job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' } }), error: null },
      '正在安装…',
    ],
    ['待重启', { snapshot: baseSnapshot({ canInstall: false, blockedReason: 'pending-restart' }), error: null }, '待重启'],
    [
      '装失败',
      { snapshot: baseSnapshot({ job: { id: 'j', state: 'failed', targetVersion: '1.1.0', message: 'install-failed: x', requestId: 'r' } }), error: null },
      '更新失败，点此查看',
    ],
    ['查失败', { snapshot: null, error: 'check-failed' }, '更新失败，点此查看'],
  ]
  for (const [name, state, want] of cases) {
    assert.equal(entryLabelFor(state), want, name)
    assert.ok(!/pending-restart|check-failed|installing|failed/.test(entryLabelFor(state)), name + ' 不许把稳定码露给用户')
  }
  assert.equal(entryLabelFor(undefined), '检查更新', '没状态就当没查过')
})

test('快照一变按钮文案就跟着变（DOM 上也一样）', async () => {
  const { call } = fakeCall({ status: statusReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 60000 })
  await settled()
  assert.match(box.innerHTML, /有新版 1\.1\.0/)
  assert.match(box.innerHTML, /data-state="update"/)
  assert.equal(entry.label(), '有新版 1.1.0')
  entry.unmount()
})

// ---------- 什么时候查：mount 只读一次 / never 等用户点 ----------

test("autoCheck='never'：挂载不打电话，用户点击才联网查（.updateCheck）", async () => {
  const { call, log } = fakeCall({ status: statusReply(UP_TO_DATE), check: checkReply(UP_TO_DATE) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, autoCheck: 'never', pollMs: 60000 })
  await settled()
  assert.deepEqual(log, [], 'never 就是挂载一条电话都不打')
  box.click(CLICK_ENTRY)
  await settled()
  assert.deepEqual(log.map((e) => e.name), ['p.updateCheck'], '点击才联网查一次')
  assert.ok(!log.some((e) => e.name.endsWith('.updateInstall')), '查归查，装不许自动发生')
  entry.unmount()
})

// ---------- 点下去做什么：has-update / always / manual ----------

test("openOn='has-update'（默认）：点击先查一次，有新版才以 dialog 形态开面板", async () => {
  let known = UP_TO_DATE
  const { call, log } = fakeCall({
    status: () => statusReply(known),
    check: () => {
      known = baseSnapshot()
      return checkReply(known)
    },
  })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 60000 })
  await settled()
  assert.match(box.innerHTML, /检查更新/, '挂载时宿主说已是最新')
  assert.ok(!box.innerHTML.includes('data-mode="dialog"'), '没点之前没有面板')
  log.length = 0
  box.click(CLICK_ENTRY)
  await settled()
  assert.equal(log[0].name, 'p.updateCheck', '点击先查一次')
  assert.match(box.innerHTML, /data-mode="dialog"/, '有新版才以 dialog 形态开面板（复用 panel）')
  assert.match(box.innerHTML, /有新版 1\.1\.0 可装/, '面板里点明新版号')
  assert.match(box.innerHTML, /data-action="install"/, '安装是面板里的一次明确动作')
  assert.equal(entry.label(), '有新版 1.1.0')
  assert.ok(!log.some((e) => e.name.endsWith('.updateInstall')), '开面板不等于装')
  entry.unmount()
})

test("openOn='has-update'：确知没有新版就只在原地给一句「已是最新 X.Y.Z」，不开面板", async () => {
  const { call, log } = fakeCall({ status: statusReply(UP_TO_DATE), check: checkReply(UP_TO_DATE) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 60000 })
  await settled()
  box.click(CLICK_ENTRY)
  await settled()
  assert.ok(log.some((e) => e.name.endsWith('.updateCheck')), '先查了才敢说没有')
  assert.ok(!box.innerHTML.includes('data-mode="dialog"'), '没有新版就不开面板')
  assert.match(box.innerHTML, /已是最新 1\.0\.0/, '原地给一句人话提示')
  assert.match(box.innerHTML, /data-dsh-upd-entry="activate"/, '按钮还在，可以再查')
  assert.equal(entry.label(), '检查更新')
  entry.unmount()
})

test("openOn='always'：点击必开面板，但仍先查一次", async () => {
  const { call, log } = fakeCall({ status: statusReply(UP_TO_DATE), check: checkReply(UP_TO_DATE) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, openOn: 'always', pollMs: 60000 })
  await settled()
  log.length = 0
  box.click(CLICK_ENTRY)
  await settled()
  assert.equal(log[0].name, 'p.updateCheck', '开之前照样先查一次')
  assert.match(box.innerHTML, /data-mode="dialog"/, '没有新版也开（用户就是要看面板）')
  entry.unmount()
})

test("openOn='manual'：点击不开面板，改调 onActivate({hasUpdate, latestVersion})", async () => {
  const seen = []
  const { call } = fakeCall({ status: statusReply(UP_TO_DATE), check: checkReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, {
    pluginId: 'p',
    prefix: 'p',
    call,
    openOn: 'manual',
    onActivate: (s) => seen.push(s),
    pollMs: 60000,
  })
  await settled()
  box.click(CLICK_ENTRY)
  await settled()
  assert.deepEqual(seen, [{ hasUpdate: true, latestVersion: '1.1.0' }], '把刚查到的结论交给接入方')
  assert.ok(!box.innerHTML.includes('data-mode="dialog"'), '接入方自己跳，入口件不开面板')
  entry.unmount()
})

test("openOn='direct'：点开即弹窗，不预查（面板挂载即自查）", async () => {
  const { call, log } = fakeCall({ status: statusReply(UP_TO_DATE), check: checkReply(UP_TO_DATE) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, openOn: 'direct', pollMs: 60000 })
  await settled()
  log.length = 0
  box.click(CLICK_ENTRY)
  await settled()
  assert.ok(!log.some((e) => e.name.endsWith('.updateCheck')), '不预查，直开')
  assert.match(box.innerHTML, /data-mode="dialog"/, '点开即弹窗')
  entry.unmount()
})

test("openOn='direct' + badge：仍走回调口径，不替接入方开面板", async () => {
  const seen = []
  const { call } = fakeCall({ status: statusReply(UP_TO_DATE), check: checkReply(UP_TO_DATE) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, {
    pluginId: 'p',
    prefix: 'p',
    call,
    variant: 'badge',
    openOn: 'direct',
    onActivate: (s) => seen.push(s),
    pollMs: 60000,
  })
  await settled()
  box.click(CLICK_ENTRY)
  await settled()
  assert.equal(seen.length, 1, '徽标点击仍交给接入方')
  assert.ok(!box.innerHTML.includes('data-mode="dialog"'), '徽标不自己开面板')
  entry.unmount()
})

// ---------- 另外两态：badge 与 inline ----------

test('variant=badge：只有一个小圆点，点击走 onActivate 不开面板', async () => {
  const seen = []
  const { call, log } = fakeCall({ status: statusReply(baseSnapshot()), check: checkReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, {
    pluginId: 'p',
    prefix: 'p',
    call,
    variant: 'badge',
    onActivate: (s) => seen.push(s),
    pollMs: 60000,
  })
  await settled()
  assert.match(box.innerHTML, /data-variant="badge"/)
  assert.match(box.innerHTML, /dsh-upd-entry-dot/, '徽标只有一个小圆点')
  assert.ok(!/<button[^>]*class="dsh-upd-entry-btn"/.test(box.innerHTML), '徽标形态不画文字按钮')
  assert.equal(entry.label(), '有新版 1.1.0', 'label() 仍给状态文案，接入方自己排版')
  log.length = 0
  box.click(CLICK_ENTRY)
  await settled()
  assert.deepEqual(log.map((e) => e.name), ['p.updateCheck'], '点击照样先查一次')
  assert.deepEqual(seen, [{ hasUpdate: true, latestVersion: '1.1.0' }])
  assert.ok(!box.innerHTML.includes('data-mode="dialog"'), '徽标不自己开面板')
  entry.unmount()
})

test("variant=inline：面板本体直接嵌进容器（等价 embedded），不另画按钮", async () => {
  const { call, log } = fakeCall({ status: statusReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, variant: 'inline', pollMs: 60000 })
  await settled()
  assert.match(box.innerHTML, /data-mode="embedded"/, '同一内核、内嵌摆放')
  assert.match(box.innerHTML, /data-action="install"/, '安装入口在面板里')
  assert.ok(!/<button[^>]*class="dsh-upd-entry-btn"/.test(box.innerHTML), 'inline 不另画按钮')
  assert.equal(entry.label(), '有新版 1.1.0', '状态文案仍可读（给接入方排版用）')
  entry.close()
  assert.match(box.innerHTML, /data-mode="embedded"/, 'close() 只管 dialog，不动内嵌本体')
  assert.ok(!log.some((e) => e.name.endsWith('.updateInstall')), '内嵌也不自动装')
  entry.unmount()
})

// ---------- 铁律：任何路径都不自动安装 ----------

test('铁律：三种形态整个生命周期里只打只读电话，绝不出现安装电话', async () => {
  for (const variant of ['button', 'badge', 'inline']) {
    const { call, log } = fakeCall({ status: statusReply(baseSnapshot()) })
    const box = fakeContainer()
    const entry = mountUpdateEntry(box, {
      pluginId: 'p',
      prefix: 'p',
      call,
      variant,
      onActivate: () => {},
      pollMs: 250,
    })
    await settled()
    box.click(CLICK_ENTRY)
    await settled()
    box.click(CLICK_CLOSE)
    await settled()
    await entry.refresh()
    entry.open()
    await settled()
    entry.close()
    await settled()
    entry.unmount()
    await settled()
    const names = [...new Set(log.map((e) => e.name))]
    assert.ok(
      names.every((n) => n === 'p.updateStatus' || n === 'p.updateCheck' || n === 'p.updateChangelog'),
      variant + '：只许打只读电话，实际=' + JSON.stringify(names),
    )
    assert.ok(!log.some((e) => e.name.endsWith('.updateInstall')), variant + '：全生命周期不许自动安装')
  }
})

// ---------- 关与卸 ----------

test('close() 收起 dialog 并把按钮还原，面板轮询随即停', async () => {
  const { call, log } = fakeCall({ status: statusReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 250 })
  await settled()
  entry.open()
  assert.match(box.innerHTML, /data-mode="dialog"/)
  const beforePoll = log.length
  await new Promise((r) => setTimeout(r, 400))
  assert.ok(log.length > beforePoll, '面板开着时按 pollMs 轮询进度')
  entry.close()
  assert.ok(!box.innerHTML.includes('data-mode="dialog"'), 'close 即收起浮层')
  assert.match(box.innerHTML, /data-dsh-upd-entry="activate"/, '按钮还原')
  await settled()
  const after = log.length
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(log.length, after, '收起来即停轮询')
  assert.ok(!log.some((e) => e.name.endsWith('.updateInstall')), '关面板绝不调安装')
  entry.unmount()
})

test('弹窗里的「关闭」点下去：入口件收起浮层并停轮询（面板自己只停轮询）', async () => {
  const { call, log } = fakeCall({ status: statusReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 250 })
  await settled()
  entry.open()
  assert.match(box.innerHTML, /data-action="close-view"/)
  assert.equal(box.listenerCount('click'), 2, '入口件一个监听、面板一个监听')
  box.click(CLICK_CLOSE)
  assert.ok(!box.innerHTML.includes('data-mode="dialog"'), '浮层收起')
  assert.match(box.innerHTML, /dsh-upd-entry-btn/, '按钮回来了')
  assert.equal(box.listenerCount('click'), 1, '面板的监听随卸载拆掉')
  await settled()
  const after = log.length
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(log.length, after, '面板轮询停了')
  entry.unmount()
})

test('unmount() 只停轮询：之后 refresh/点击都不再打电话，监听也拆干净', async () => {
  const { call, log } = fakeCall({ status: statusReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 250 })
  await settled()
  entry.open()
  await settled()
  const before = log.length
  entry.unmount()
  assert.equal(box.listenerCount('click'), 0, '监听拆干净')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(log.length, before, '卸载后面板轮询即停')
  await entry.refresh()
  box.click(CLICK_ENTRY)
  await settled()
  assert.equal(log.length, before, '卸载后 refresh/点击都是空操作')
  assert.ok(!log.some((e) => e.name.endsWith('.updateInstall')), '卸载绝不调安装/取消')
})

// ---------- 主题与文案覆盖 ----------

test('主题 default / d5-paper 双态可切：入口件与面板一起换肤', async () => {
  const { call } = fakeCall({ status: statusReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 60000 })
  await settled()
  entry.setTheme('d5-paper')
  assert.match(box.innerHTML, /<span class="dsh-upd-entry"[^>]*data-theme="d5-paper"/, '还没开面板时入口件自己先带上主题')
  entry.open()
  assert.match(box.innerHTML, /data-mode="dialog"/)
  assert.match(box.innerHTML, /<div class="dsh-upd" data-mode="dialog"[^>]*data-theme="d5-paper"/, '面板跟着同一个主题')
  entry.setTheme('default')
  assert.ok(!/<div class="dsh-upd" data-mode="dialog"[^>]*data-theme=/.test(box.innerHTML), '切回默认即不再带 D5 串')
  entry.close()
  assert.match(box.innerHTML, /data-dsh-upd-entry="activate"/)
  assert.ok(!/<span class="dsh-upd-entry"[^>]*data-theme=/.test(box.innerHTML), '还原的按钮也回默认主题')
  entry.unmount()
})

test('label 显式覆盖：接入方给了文案就用它的，状态照样带在 DOM 上', async () => {
  const { call } = fakeCall({ status: statusReply(baseSnapshot()) })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, label: '更新看看', pollMs: 60000 })
  await settled()
  assert.equal(entry.label(), '更新看看')
  assert.match(box.innerHTML, />更新看看</)
  assert.match(box.innerHTML, /data-state="update"/, '状态仍如实带在 DOM 上')
  entry.unmount()
})

// ---------- 查不出来也要让用户看见 ----------

test('查新版失败也开面板：把失败摊给用户看，而不是咽掉', async () => {
  const { call } = fakeCall({
    status: statusReply(UP_TO_DATE),
    check: { ok: false, error: 'check-failed', errorKind: 'check-failed' },
  })
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 60000 })
  await settled()
  box.click(CLICK_ENTRY)
  await settled()
  assert.match(box.innerHTML, /data-mode="dialog"/, '查不出来就打开面板，让用户看见原因')
  assert.equal(entry.label(), '更新失败，点此查看')
  entry.unmount()
})

// ---------- 参数校验与分发 ----------

test('参数校验与面板同一口径：轮询下限、必填项、取值白名单', () => {
  const call = async () => ({})
  const box = fakeContainer()
  assert.throws(() => mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 100 }), /250/)
  assert.throws(() => mountUpdateEntry(box, { pluginId: 'p', prefix: 'p' }), /call/)
  assert.throws(() => mountUpdateEntry(box, { prefix: 'p', call }), /pluginId/)
  assert.throws(() => mountUpdateEntry({}, { pluginId: 'p', prefix: 'p', call }), /innerHTML/)
  assert.throws(() => mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, variant: 'nope' }), /形态/)
  assert.throws(() => mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, openOn: 'nope' }), /去向/)
  assert.throws(() => mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, autoCheck: 'nope' }), /时机/)
  assert.throws(() => mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, theme: 'nope' }), /主题/)
  assert.throws(() => mountUpdateEntry(box, { pluginId: 'p', prefix: 'p.', call }), /前缀/)
})

test('入口件零 Node 专属能力，源码里不出现安装电话，类型随包分发', () => {
  const source = readFileSync(join(PKG_DIR, 'src', 'entry.ts'), 'utf8')
  assert.ok(!/from 'node:/.test(source), '入口件不得出现 node: 导入（浏览器闭包进不去）')
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.ok(!code.includes('updateInstall'), '入口件只许查：源码里不许出现安装电话')
  const dts = join(PKG_DIR, 'dist', 'entry.d.ts')
  assert.ok(existsSync(dts), 'dist/entry.d.ts 已产出')
  const text = readFileSync(dts, 'utf8')
  assert.match(text, /mountUpdateEntry/, '类型定义含挂载入口')
  assert.match(text, /entryLabelFor/, '类型定义含状态文案纯函数')
  const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
  assert.ok(manifest.exports['./entry'], '包出口含 ./entry')
})
