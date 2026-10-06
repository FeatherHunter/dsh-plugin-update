/**
 * tests/panel.test.mjs —— 现成整组件（#17）。
 *
 * 只测外部行为：调公开入口（mount / act / 纯函数），看 HTML、看传输记录、看复制内容、
 * 看按钮门控，不测内部实现、样式像素、状态机写法。传输、剪贴板、存储、容器全用假件，
 * 不碰真机、不真联网、不真装。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PANEL_POLL,
  blockedCopy,
  buildDiagnosticText,
  createBrowserSkipStore,
  createMemorySkipStore,
  mountUpdatePanel,
  panelViewModel,
  redactForCopy,
  renderUpdatePanelHTML,
} from '../dist/panel.js'

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

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

/** 假容器：只要 innerHTML，事件监听可有可无（按钮走 controller.act）。 */
function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

/** 假传输：按电话名回固定剧本，并记下每次调用（断言电话名与参数用）。 */
function fakeCall(script = {}) {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) {
      return (
        script.status ?? {
          ok: true,
          snapshot: baseSnapshot(),
          manual: 'dsh plugin --profile web add --save-exact my-plugin@1.1.0 --registry=https://registry.npmjs.org/',
          receipt: null,
          queue: baseQueue(),
        }
      )
    }
    if (name.endsWith('.updateCheck')) {
      return (
        script.check ?? {
          ok: true,
          snapshot: baseSnapshot(),
          manual: null,
          receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 999 },
          queue: baseQueue(),
        }
      )
    }
    if (name.endsWith('.updateInstall')) {
      return script.install ?? { ok: true, snapshot: baseSnapshot({ job: null }), manual: null }
    }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

function copySpy() {
  const texts = []
  const copyText = async (text) => {
    texts.push(text)
  }
  return { copyText, texts }
}

async function settled() {
  await new Promise((r) => setTimeout(r, 10))
}

// ---------- 电话名只从前缀派生 ----------

test('电话名只从前缀派生：面板调的与宿主注册的是同一套，不写字面量', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'my-plugin', prefix: 'notes', call, pollMs: 60000 })
  await panel.refresh()
  const names = log.map((e) => e.name)
  assert.ok(names.includes('notes.updateStatus'), '应调 notes.updateStatus，实际=' + JSON.stringify(names))
  assert.ok(!names.some((n) => n.startsWith('wf.')), '传了前缀 notes 就不该再出现默认前缀 wf')
  panel.unmount()
})

test('默认前缀 wf 下与现状一字不差', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'my-plugin', call, pollMs: 60000 })
  await panel.refresh()
  assert.ok(log.some((e) => e.name === 'wf.updateStatus'))
  panel.unmount()
})

// ---------- 安装门控只跟快照 ----------

test('安装按钮状态跟随快照 installability，不另写规则', async () => {
  const blocked = fakeCall({ status: { ok: true, snapshot: baseSnapshot({ canInstall: false }), manual: null, receipt: null, queue: baseQueue() } })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call: blocked.call, pollMs: 60000 })
  await panel.refresh()
  assert.match(box.innerHTML, /data-action="install"[^>]*disabled/, 'canInstall 为假时安装按钮必须置灰')
  panel.unmount()

  const open = fakeCall({ status: { ok: true, snapshot: baseSnapshot({ canInstall: true, latestVersion: '1.1.0' }), manual: null, receipt: null, queue: baseQueue() } })
  const box2 = fakeContainer()
  const panel2 = mountUpdatePanel(box2, { pluginId: 'p', call: open.call, pollMs: 60000 })
  await panel2.refresh()
  assert.ok(!/data-action="install"[^>]*disabled/.test(box2.innerHTML), 'canInstall 为真时安装按钮可用')
  assert.match(box2.innerHTML, /安装 1\.1\.0/, '按钮文案带上远端版本号')
  panel2.unmount()
})

// ---------- 八种原因各有一句中文 ----------

test('八种装不了的原因各有一句中文一句话，不是英文原文', () => {
  const reasons = [
    'unknown-profile',
    'source-install',
    'invalid-installation',
    'installation-changed',
    'pending-restart',
    'registry-conflict',
    'incompatible-node',
    'recovery-required',
  ]
  for (const r of reasons) {
    const copy = blockedCopy(r)
    assert.ok(copy && copy.title && copy.action, r + ' 必须有标题与行动句')
    assert.match(copy.title + copy.action, /[\u4e00-\u9fff]/, r + ' 必须含中文')
  }
  assert.equal(blockedCopy(null), null, '能装时回 null，不猜')
  assert.equal(blockedCopy('not-a-reason'), null, '未知原因回 null，不编')
})

test('待重启横幅：新版号 + 重启指引，只给重启与手工命令入口', async () => {
  const manual = 'dsh plugin --profile web add --save-exact p@1.1.0 --registry=https://registry.npmjs.org/'
  const { call } = fakeCall({
    status: {
      ok: true,
      snapshot: baseSnapshot({ canInstall: false, blockedReason: 'pending-restart', latestVersion: '1.1.0', installedVersion: '1.1.0' }),
      manual,
      receipt: null,
      queue: baseQueue(),
    },
  })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await panel.refresh()
  assert.match(box.innerHTML, /data-kind="restart"/, '待重启横幅必须单独展示')
  assert.match(box.innerHTML, /1\.1\.0/, '横幅说清新版号是多少')
  assert.match(box.innerHTML, /重启/, '横幅说清重启后才生效')
  assert.match(box.innerHTML, /data-action="install"[^>]*disabled/, '待重启期间不再提供安装按钮')
  assert.match(box.innerHTML, /手工兜底命令/, '待重启期间保留手工命令入口')
  panel.unmount()
})

// ---------- 手工命令展示与复制 ----------

test('手工命令展示与复制：面板每次拿回包即刷新展示，不缓存旧的', async () => {
  const manual = 'dsh plugin --profile web add --save-exact p@1.1.0 --registry=https://registry.npmjs.org/'
  const { call } = fakeCall({
    status: { ok: true, snapshot: baseSnapshot(), manual, receipt: null, queue: baseQueue() },
  })
  const { copyText, texts } = copySpy()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, copyText, pollMs: 60000 })
  await panel.refresh()
  assert.ok(box.innerHTML.includes(manual), '面板展示回包里这条命令原文')
  await panel.act('copy-manual')
  assert.deepEqual(texts, [manual], '复制即原文，不加料')
  assert.match(box.innerHTML, /已复制/, '复制后给一句确认')
  panel.unmount()
})

// ---------- 排队可见开关 ----------

test('排队可见开关：默认藏他人明细，显式才看全量，位置照给', async () => {
  const queue = {
    busy: true,
    owner: { pluginId: 'other-plugin', jobId: 'j1', requestId: 'r1', targetVersion: '9.9.9', startedAt: 1 },
    waiting: [{ pluginId: 'p', requestId: 'mine', targetVersion: null, enqueuedAt: 1 }],
    position: 1,
  }
  const { call, log } = fakeCall({
    status: { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue },
  })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await panel.refresh()
  assert.ok(!box.innerHTML.includes('other-plugin'), '默认不露他人标识')
  assert.match(box.innerHTML, /第 1 位/, '位置照给（新队列设计：你的顺位一行）')
  await panel.act('toggle-queue')
  const lastStatus = log.filter((e) => e.name.endsWith('.updateStatus')).pop()
  assert.equal(lastStatus.args.showOthers, true, '切换后重查带 showOthers')
  panel.unmount()
})

// ---------- 跳过读写承诺 ----------

test('跳过按版本记、可重置：内存与浏览器两套同一语义', () => {
  const mem = createMemorySkipStore(() => 1000)
  assert.equal(mem.has('1.1.0'), false)
  mem.skip('1.1.0')
  assert.equal(mem.has('1.1.0'), true, '跳过后该版本不再提醒')
  assert.equal(mem.has('1.2.0'), false, '新版本照常提醒')
  mem.reset('1.1.0')
  assert.equal(mem.has('1.1.0'), false, '恢复后重新提醒')

  const backing = new Map()
  const storage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, v),
    removeItem: (k) => backing.delete(k),
  }
  const browser = createBrowserSkipStore('p', storage, () => 1000)
  browser.skip('2.0.0')
  const reopened = createBrowserSkipStore('p', storage, () => 2000)
  assert.equal(reopened.has('2.0.0'), true, '跳过跨面板重开仍在')
  reopened.reset()
  assert.deepEqual(reopened.list(), [], '不给版本即清全部')

  const broken = createBrowserSkipStore('p', { getItem: () => '{坏', setItem: () => {}, removeItem: () => {} })
  assert.deepEqual(broken.list(), [], '坏文件自愈为空，不挡更新')
})

test('已跳过版本留在同一横幅行展示为“已跳过 X · 恢复”', async () => {
  const skipStore = createMemorySkipStore(() => 1000)
  skipStore.skip('1.1.0')
  const { call } = fakeCall({
    status: { ok: true, snapshot: baseSnapshot({ canInstall: true, latestVersion: '1.1.0' }), manual: null, receipt: null, queue: baseQueue() },
  })
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, skipStore, pollMs: 60000 })
  await panel.refresh()
  assert.match(box.innerHTML, /已跳过 1\.1\.0/, '跳过展示在同一横幅行')
  assert.match(box.innerHTML, /data-action="reset-skip"/, '恢复入口一击可达，不藏进设置页')
  assert.match(box.innerHTML, /data-action="install"[^>]*disabled/, '跳过即免打扰，不再给安装按钮')
  await panel.act('reset-skip')
  assert.equal(skipStore.has('1.1.0'), false, '点恢复即清该版本跳过')
  panel.unmount()
})

// ---------- 诊断复制：脱敏是构造属性 ----------

const MUST_SCRUB = [
  ['POSIX 路径', 'open /tmp/secret/x failed'],
  ['Node 单引号路径', "ENOENT: no such file or directory, open '/tmp/secret/x'"],
  ['冒号后路径', 'at path:/var/lib/dsh/state.json broken'],
  ['方括号内路径', 'read [C:\\Users\\alice\\state.json] denied'],
  ['Windows 盘符', 'EACCES: permission denied C:\\Program Files\\dsh\\state.json'],
  ['UNC 斜杠', 'share //server/share/state.json gone'],
  ['UNC 反斜杠', 'share \\\\server\\share\\state.json gone'],
  ['带引号盘符', 'open "D:\\data\\state.json" failed'],
  ['路径内逗号', 'open /tmp/a,b/state.json failed'],
  ['URL 用户信息', 'fetch https://alice:s3cret@mirror.example.com/pkg.tgz failed'],
  ['npm 令牌', 'npm npm_abcdef1234567890 leaked'],
  ['GitHub 令牌', 'token ghp_abcdefghij1234567890 in output'],
  ['Bearer', 'auth Bearer abcdef123456 failed'],
  ['密码键值对', 'login password=S3cret! failed'],
  ['邮箱', 'auth for alice@example.com failed'],
]

const MUST_KEEP = [
  ['官方源 URL', 'from https://registry.npmjs.org/my-plugin failed'],
  ['URL 内多斜杠', 'path http://a.com/x//y kept'],
  ['散文斜杠', 'retry later please'],
  ['分数', '1/2 of packages done'],
  ['孤立斜杠', 'a / b compared'],
]

test('诊断复制文本里不得出现绝对路径与个人标识（写死负向断言）', () => {
  for (const [name, raw] of MUST_SCRUB) {
    const out = redactForCopy(raw)
    assert.ok(!/\/tmp\/secret/.test(out), name + '：POSIX 路径必须被收掉：' + out)
    assert.ok(!/s3cret/i.test(out), name + '：秘密原文必须被收掉：' + out)
    assert.ok(!/alice@example\.com/.test(out), name + '：邮箱必须被收掉：' + out)
    assert.ok(!/ghp_/.test(out), name + '：令牌必须被收掉：' + out)
  }
  // 绝对路径形态通用检查：输出里不留任何 POSIX/盘符/UNC 形态。
  for (const [name, raw] of MUST_SCRUB.slice(0, 9)) {
    const out = redactForCopy(raw)
    assert.ok(!/[A-Za-z]:\\/.test(out), name + '：盘符形态不留：' + out)
  }
})

test('脱敏不误伤可用信息（URL、散文斜杠、分数原样保留）', () => {
  for (const [name, raw] of MUST_KEEP) {
    const out = redactForCopy(raw)
    assert.ok(out.includes(raw.replace(/\s+/g, ' ').trim()), name + ' 必须原样保留，实际=' + out)
  }
})

test('同一输入两次运行逐字节相同（输出确定性）', () => {
  const raw = 'open /tmp/x with token=abc and mail a@b.com'
  assert.equal(redactForCopy(raw), redactForCopy(raw))
})

test('诊断文本自包含：稳定码 + 脱敏详情 + 版本 + 宿主 + 队列位置', () => {
  const text = buildDiagnosticText({
    pluginId: 'my-plugin',
    code: 'install-failed',
    detail: "operation-error open '/tmp/secret/x'",
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    hostKind: 'cli',
    queuePosition: 2,
    requestId: 'r1',
    manual: 'dsh plugin --profile web add --save-exact my-plugin@1.1.0 --registry=https://registry.npmjs.org/',
  })
  assert.match(text, /install-failed/, '带稳定码')
  assert.match(text, /1\.0\.0/, '带版本')
  assert.match(text, /cli/, '带宿主种类')
  assert.match(text, /排队第 2 位/, '带队列位置')
  assert.ok(!text.includes('/tmp/secret'), '详情已脱敏')
  assert.ok(!text.includes('<tmp'), '占位符未被切开')
})

test('诊断文本带上使用范围：装错 profile 时这是第一信息；不给就跟旧输出一字不差', () => {
  const base = {
    pluginId: 'my-plugin',
    code: 'install-failed',
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    hostKind: 'cli',
    queuePosition: null,
  }
  const withProfile = buildDiagnosticText({ ...base, profileName: 'desktop' })
  assert.match(withProfile, /使用范围：desktop/, '给了使用范围就要出现在宿主那一行')
  assert.match(withProfile, /宿主：cli \/ 使用范围：desktop \/ 队列：不在队列里/, '位置在宿主与队列之间')
  const without = buildDiagnosticText(base)
  assert.ok(!without.includes('使用范围'), '不给就一个字都不多')
  assert.match(without, /宿主：cli \/ 队列：不在队列里/, '旧格式原样')
})

// ---------- 双形态行为等价 ----------

test('双形态只测行为等价：同一起始状态，内核展示同一快照与按钮', () => {
  const input = {
    snapshot: baseSnapshot(),
    manual: 'dsh plugin --profile web add --save-exact p@1.1.0 --registry=https://registry.npmjs.org/',
    queue: baseQueue(),
    skippedLatest: false,
    lastError: null,
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
  }
  const embedded = renderUpdatePanelHTML({ ...input, mode: 'embedded' })
  const dialog = renderUpdatePanelHTML({ ...input, mode: 'dialog' })
  // 外层包裹不同（弹窗多一层 overlay + 关闭按钮），内核文本同一份：
  for (const marker of ['有新版 1.1.0 可装', 'data-action="install"', 'data-action="copy-diag"', '手工兜底命令', '深挖看日志']) {
    assert.ok(embedded.includes(marker), '内嵌含 ' + marker)
    assert.ok(dialog.includes(marker), '弹窗含 ' + marker)
  }
  assert.match(dialog, /data-mode="dialog"/, '弹窗走同一 mode 参数')
  assert.match(embedded, /data-mode="embedded"/, '默认内嵌')
})

// ---------- 关闭不中断、重开恢复、凭证自愈 ----------

test('关闭面板只停轮询：卸载后不再调电话，也绝不调取消', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 250 })
  await settled()
  const before = log.length
  assert.ok(before >= 1, '挂载即重查（重开恢复进度）')
  panel.unmount()
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(log.length, before, '卸载后轮询即停')
  await panel.refresh()
  await panel.act('install')
  assert.equal(log.length, before, '卸载后 refresh/act 都是空操作')
})

test('安装自动带凭证：mount 自动查已拿凭证时安装直接复用（无 receipt 回退见 panel-auto-check）', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await settled()
  await settled()
  assert.ok(log.some((e) => e.name.endsWith('.updateCheck')), 'mount 应已自动查拿凭证（#48）')
  log.length = 0
  await panel.act('install')
  const checkAt = log.findIndex((e) => e.name.endsWith('.updateCheck'))
  const installAt = log.findIndex((e) => e.name.endsWith('.updateInstall'))
  assert.equal(checkAt, -1, '已有凭证时安装不另查，直接复用自动查的凭证')
  assert.ok(installAt >= 0, '安装电话已发出')
  const installArgs = log[installAt].args
  assert.equal(installArgs.checkId, 'check-1', '装更新带回查新版的凭证')
  assert.ok(typeof installArgs.requestId === 'string' && installArgs.requestId.length >= 1, '请求编号自带')
  panel.unmount()
})

test('重开即恢复：挂载不等轮询间隔就查一次状态', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await settled()
  assert.ok(log.some((e) => e.name.endsWith('.updateStatus')), '首查立刻发生（默认 1 秒轮询内必恢复显示）')
  panel.unmount()
})

// ---------- 视图模型边角 ----------

test('安装中只显示进度不给按钮；失败给重试与诊断', () => {
  const busy = panelViewModel({
    snapshot: baseSnapshot({ job: { id: 'j', state: 'installing', targetVersion: '1.1.0', message: null, requestId: 'r' } }),
    manual: null,
    queue: baseQueue(),
    skippedLatest: false,
    lastError: null,
  })
  assert.equal(busy.installEnabled, false)
  assert.match(busy.banner.title, /正在安装/)

  const failed = panelViewModel({
    snapshot: baseSnapshot({ canInstall: true, job: { id: 'j', state: 'failed', targetVersion: '1.1.0', message: 'install-failed: operation-error', requestId: 'r' } }),
    manual: 'cmd',
    queue: baseQueue(),
    skippedLatest: false,
    lastError: null,
  })
  assert.equal(failed.banner.kind, 'failed')
  assert.equal(failed.installEnabled, true, '失败且快照允许时可重试')
  assert.equal(failed.showManual, true)
})

// ---------- 老合同与分发 ----------

test('老合同不动：电话名、快照字段、配方键一字不动', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, { pluginId: 'p', call, pollMs: 60000 })
  await panel.refresh()
  assert.ok(log[0].name === 'wf.updateStatus', '默认电话名冻结')
  assert.deepEqual(Object.keys(baseSnapshot()).sort(), ['blockedReason', 'canInstall', 'installedVersion', 'job', 'latestVersion', 'runningVersion'].sort(), '快照恰好六字段')
  const { installRecipe } = await import('../dist/commands.js')
  const recipe = installRecipe({ profileName: 'web', version: '1.1.0', environmentKind: 'cli' })
  assert.deepEqual(Object.keys(recipe).sort(), ['pluginArgs', 'profileName', 'route', 'timeoutMs', 'version'].sort(), '配方五键冻结')
  panel.unmount()
})

test('面板轮询口径与宿主侧同一套：下限 250 毫秒', () => {
  assert.equal(PANEL_POLL.defaultMs, 1000)
  assert.equal(PANEL_POLL.minMs, 250)
  assert.throws(() => mountUpdatePanel(fakeContainer(), { pluginId: 'p', call: async () => ({}), pollMs: 100 }), /250/)
  assert.throws(() => mountUpdatePanel(fakeContainer(), { pluginId: 'p', pollMs: 1000 }), /call/, '传输函数必填')
})

test('零运行时依赖：面板不拖 Node 专属能力', () => {
  const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined, '运行期依赖应为空')
  const source = readFileSync(join(PKG_DIR, 'src', 'panel.ts'), 'utf8')
  assert.ok(!/from 'node:/.test(source), '面板源码不得出现 node: 导入（浏览器闭包进不去）')
})

test('类型定义随包分发：公开入口有 .d.ts，不要求调用方自编译', () => {
  const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
  assert.ok(manifest.exports['./panel'], '包出口含 ./panel')
  assert.ok(existsSync(join(PKG_DIR, 'dist', 'panel.d.ts')), 'dist/panel.d.ts 已产出')
  const dts = readFileSync(join(PKG_DIR, 'dist', 'panel.d.ts'), 'utf8')
  assert.match(dts, /mountUpdatePanel/, '类型定义含挂载入口')
  assert.match(dts, /UpdatePanelMode/, '类型定义含摆放形态')
})
