/**
 * tests/panel-diag-22.test.mjs —— #22 面板诊断渲染专业版验收。
 *
 * 只测外部行为：调公开入口（failureCopy / failureCodeOf / readDiagTolerant /
 * buildUpdateDiagCopy / panelViewModel / mount），看文案、看分支、看复制内容、
 * 看来源补齐，不测内部实现、样式像素、状态机写法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blockedCopy,
  failureCopy,
  isKnownFailureCode,
  failureCodeOf,
  readDiagTolerant,
  buildUpdateDiagCopy,
  buildDiagnosticText,
  panelViewModel,
  mountUpdatePanel,
} from '../dist/panel.js'

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

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

// ---------- 15 码全覆盖 ----------

test('#22 15码全覆盖：9阻塞+5电话+internal 各有一句中文，未来码走兜底', () => {
  const eight = [
    'unknown-profile',
    'channel-mismatch',
    'source-install',
    'invalid-installation',
    'installation-changed',
    'pending-restart',
    'registry-conflict',
    'incompatible-node',
    'recovery-required',
  ]
  for (const c of eight) {
    const f = failureCopy(c)
    const b = blockedCopy(c)
    assert.ok(f && f.zh && f.act, c + ' 必须有中文与行动句')
    assert.match(f.zh + f.act, /[\u4e00-\u9fff]/, c + ' 必须含中文')
    assert.equal(f.zh, b.title, c + ' 9行复用阻塞表原文，不另起措辞')
    assert.ok(isKnownFailureCode(c), c + ' 应在15码内')
  }
  const five = ['check-failed', 'invalid-release', 'check-expired', 'update-busy', 'install-failed']
  for (const c of five) {
    const f = failureCopy(c)
    assert.ok(f && f.zh && f.act, c + ' 必须有中文与行动句')
    assert.match(f.zh + f.act, /[\u4e00-\u9fff]/, c + ' 必须含中文')
    assert.ok(isKnownFailureCode(c), c + ' 应在15码内')
  }
  const internal = failureCopy('internal')
  assert.ok(internal && internal.zh && internal.act, 'internal 必须有兜底中文')
  assert.ok(isKnownFailureCode('internal'), 'internal 计入15码')
  const future = failureCopy('quota-exceeded')
  assert.ok(future && future.zh && future.act, '未来码必须有兜底')
  assert.match(future.act, /带上你看到的码/, '未来兜底必须提醒带上原码')
  assert.equal(isKnownFailureCode('quota-exceeded'), false, '未来码不在15码内')
  assert.equal(failureCopy(null), null, '空码回 null，不猜')
  assert.equal(failureCopy(''), null, '空串回 null')
})

test('#22 老入口兼容：buildDiagnosticText 仍可用，电话码有行动句回退', () => {
  const text = buildDiagnosticText({
    pluginId: 'p',
    code: 'check-failed',
    detail: '',
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    hostKind: 'cli',
    queuePosition: null,
    requestId: null,
    manual: null,
  })
  assert.match(text, /check-failed/, '带稳定码')
  assert.match(text, /[\u4e00-\u9fff]/, '有中文回退，不只剩英文码')
})

// ---------- errorKind 分支 ----------

test('#22 按errorKind分支：errorKind=internal 时不误判为查新版失败', () => {
  assert.equal(failureCodeOf({ error: 'check-failed', errorKind: 'internal' }), 'internal')
  assert.equal(failureCodeOf({ error: 'check-failed', errorKind: 'check-failed' }), 'check-failed')
  assert.equal(failureCodeOf({ error: 'check-failed' }), 'check-failed', '无errorKind时回退到error')
  assert.equal(failureCodeOf({}), 'internal', '双缺省回 internal')
  assert.equal(failureCodeOf(null, 'install-failed'), 'install-failed', '回退码生效')

  const view = panelViewModel({
    snapshot: baseSnapshot({ canInstall: false }),
    manual: null,
    queue: baseQueue(),
    skippedLatest: false,
    lastError: 'check-failed',
    errorKind: 'internal',
  })
  assert.equal(view.banner.kind, 'failed')
  assert.match(view.banner.title, /internal/, '标题用 errorKind，不用已被改写的 error')
  assert.ok(!view.banner.title.includes('查新版没成功'), 'internal 不许说查新版失败那句')
  assert.match(view.banner.action, /重试/, 'internal 有自己的行动句')
})

test('#22 未知码走兜底但标题保留原码', () => {
  const view = panelViewModel({
    snapshot: baseSnapshot({ canInstall: false }),
    manual: null,
    queue: baseQueue(),
    skippedLatest: false,
    lastError: 'quota-exceeded',
    errorKind: 'quota-exceeded',
  })
  assert.match(view.banner.title, /quota-exceeded/, '标题保留原码供定位')
  assert.match(view.banner.action, /带上你看到的码/, '行动句提醒带码')
})

// ---------- 宽容读 ----------

test('#22 宽容读：未知键忽略、错类型忽略、缺省当正常，永不抛', () => {
  const d1 = readDiagTolerant({ v: 1, stage: 'exec', route: 'desktop-manager', queuePos: 1, _x: { deep: 1 } })
  assert.equal(d1.stage, 'exec')
  assert.equal(d1.route, 'desktop-manager')
  assert.deepEqual(d1.unknownKeys.sort(), ['_x', 'queuePos'].sort(), '目录外键只记 unknown，不进渲染')

  const d2 = readDiagTolerant('我是个字符串')
  assert.equal(d2.stage, null, '非对象全缺省')

  const d3 = readDiagTolerant({ v: '1', stage: 123, httpStatus: '429', detail: { text: 1 } })
  assert.equal(d3.stage, null, '错类型一律忽略')
  assert.equal(d3.httpStatus, null)
  assert.equal(d3.detail, null)

  const d4 = readDiagTolerant(null)
  assert.equal(d4.present, undefined, '无 present 字段也行，只断缺省')
  assert.equal(d4.stage, null)
})

// ---------- 双形态同序 ----------

test('#22 双形态内容顺序完全一致：码→摘要→来源，块三行、单行无换行', () => {
  const input = {
    pluginId: 'my-plugin',
    code: 'install-failed',
    detail: '宿主管理器返回 operation-error',
    runningVersion: '1.2.2',
    installedVersion: '1.2.2',
    latestVersion: '1.2.3',
    hostKind: 'desktop',
    queuePosition: 2,
    requestId: 'req-7f3a91',
    checkId: 'chk-2b81',
    route: 'desktop-manager',
    diag: {
      v: 1,
      stage: 'exec',
      route: 'desktop-manager',
      method: 'phone',
      exitCode: 1,
      detail: '宿主管理器返回 operation-error',
      targetPackageName: 'my-plugin',
      runningVersion: '1.2.2',
      environmentKind: 'desktop',
      requestId: 'req-7f3a91',
      checkId: 'chk-2b81',
      action: 'contact',
    },
  }
  const block = buildUpdateDiagCopy({ ...input, format: 'block' })
  const line = buildUpdateDiagCopy({ ...input, format: 'line' })
  for (const s of [block, line]) {
    assert.match(s, /\[update-diag\]/, '双形态都带 [update-diag] tag')
    assert.match(s, /install-failed/, '带稳定码')
  }
  assert.ok(block.includes('\n'), '块默认三行以上，保留换行')
  assert.equal(line.includes('\n'), false, '单行无换行')
  // 同序：码 → 中文 → 摘要 → 来源 → 怎么办，在两形态中相对顺序一致（第一性：怎么办是页脚，不插断码→摘要→来源）
  //（块用全角冒号、单行用等号，分形态断，避免中文里的“摘要”二字干扰）
  const blockOrder = ['install-failed', '装不上', '  摘要：宿主管理器', '  来源：', '插件=my-plugin', '路由=desktop-manager', '请求=req-7f3a91', '检查=chk-2b81', '  怎么办：']
  const lineOrder = ['install-failed', '装不上', '摘要=宿主管理器', '插件=my-plugin', '路由=desktop-manager', '请求=req-7f3a91', '检查=chk-2b81', '怎么办=']
  for (const [s, order] of [[block, blockOrder], [line, lineOrder]]) {
    let last = -1
    for (const seg of order) {
      const at = s.indexOf(seg)
      assert.ok(at > last, `顺序一致：${seg} 应在前一段之后（${s.slice(0, 120)}…）`)
      last = at
    }
  }
  // 阶段/方法/exit/action 进来源，不改变分支
  assert.match(block, /阶段=exec/, '来源含阶段')
  assert.match(block, /建议=contact/, '来源含包内推导的建议（只渲染）')
})

// ---------- 来源补齐缺省人话 ----------

test('#22 来源补齐缺省即省略：无diag时路由/请求/检查不出现，恒显插件/队列/源人话', () => {
  const block = buildUpdateDiagCopy({
    pluginId: 'p',
    code: 'check-failed',
    detail: '',
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: null,
    hostKind: null,
    queuePosition: null,
    requestId: null,
    checkId: null,
    route: null,
    diag: null,
  })
  assert.ok(!block.includes('路由='), '路由缺省即省略，不占位未知')
  assert.ok(!block.includes('请求='), '请求缺省即省略')
  assert.ok(!block.includes('检查='), '检查缺省即省略')
  assert.match(block, /本回包没有带诊断摘要/, '摘要缺省说人话，不留白')
  assert.match(block, /源=未知/, '源缺省给人话（省略本身即信息，人读不懂所以必须说）')
  assert.match(block, /插件=p/, '插件恒显')
  assert.match(block, /不在队列里/, '队列恒显人话')
})

// ---------- queuePos 转正前兼容 ----------

test('#22 queuePos转正前忽略：目录外键静默丢，只看队列视图', () => {
  const fromView = buildUpdateDiagCopy({
    pluginId: 'p',
    code: 'update-busy',
    detail: '',
    queuePosition: 1,
    diag: { queuePos: 5 },
  })
  assert.match(fromView, /排队第 1 位/, '视图生效，目录外键不干扰')

  const ignored = buildUpdateDiagCopy({
    pluginId: 'p',
    code: 'update-busy',
    detail: '',
    queuePosition: null,
    diag: { queuePos: 2 },
  })
  assert.match(ignored, /不在队列里/, '转正前 diag.queuePos 必须忽略，不补充')

  const none = buildUpdateDiagCopy({ pluginId: 'p', code: 'update-busy', detail: '' })
  assert.match(none, /不在队列里/, '双无时说人话')
})

// ---------- 只渲染不推导 ----------

test('#22 只渲染不推导：action只取包内值，不按httpStatus自推分支', () => {
  const withAction = buildUpdateDiagCopy({
    pluginId: 'p',
    code: 'check-failed',
    detail: '源返回 429',
    diag: { v: 1, stage: 'fetch-release', route: 'registry', method: 'https', httpStatus: 429, action: 'retry' },
  })
  assert.match(withAction, /建议=retry/, '包内 action 原样渲染')

  const noAction = buildUpdateDiagCopy({
    pluginId: 'p',
    code: 'check-failed',
    detail: '源返回 429',
    diag: { v: 1, stage: 'fetch-release', route: 'registry', method: 'https', httpStatus: 429 },
  })
  assert.ok(!noAction.includes('建议='), '无 action 时不自推建议')

  const view429 = panelViewModel({
    snapshot: baseSnapshot({ canInstall: false }),
    manual: null,
    queue: baseQueue(),
    skippedLatest: false,
    lastError: 'check-failed',
    errorKind: 'check-failed',
  })
  assert.match(view429.banner.title, /check-failed/, '分支只用稳定码，不用 HTTP 明细')
})

// ---------- 脱敏 negative ----------

test('#22 复制块已脱敏：路径与令牌不进粘贴块', () => {
  const block = buildUpdateDiagCopy({
    pluginId: 'p',
    code: 'install-failed',
    detail: "open '/tmp/secret/x' with token=ghp_abcdefghij1234567890",
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    hostKind: 'cli',
    queuePosition: null,
    requestId: null,
    manual: 'dsh plugin --profile web add --save-exact p@1.1.0 --registry=https://registry.npmjs.org/',
  })
  assert.ok(!block.includes('/tmp/secret'), 'POSIX 路径已收')
  assert.ok(!block.includes('ghp_'), '令牌已收')
})

// ---------- 挂载复制走新块 ----------

test('#22 挂载复制诊断走[update-diag]新块：errorKind=internal 不误判', async () => {
  const box = fakeContainer()
  const texts = []
  const call = async (name) => {
    if (name.endsWith('.updateStatus')) {
      return { ok: false, error: 'check-failed', errorKind: 'internal', diag: { v: 1, stage: 'fetch-release', route: 'registry', method: 'https', httpStatus: 500, detail: '源返回 500' } }
    }
    throw new Error('unknown-phone:' + name)
  }
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    call,
    copyText: async (t) => texts.push(t),
    pollMs: 60000,
  })
  await panel.refresh()
  assert.match(box.innerHTML, /internal/, '面板标题用 errorKind=internal')
  await panel.act('copy-diag')
  assert.equal(texts.length, 1, '复制一次')
  assert.match(texts[0], /\[update-diag\]/, '复制块带 tag')
  assert.match(texts[0], /internal/, '复制块带 errorKind')
  assert.ok(!texts[0].includes('查新版没成功'), 'internal 复制块不误用 check-failed 文案')
  panel.unmount()
})

test('#22 单行形态可选：diagCopyFormat=line 时复制即单行', async () => {
  const box = fakeContainer()
  const texts = []
  const call = async () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' })
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    call,
    copyText: async (t) => texts.push(t),
    pollMs: 60000,
    diagCopyFormat: 'line',
  })
  await panel.refresh()
  await panel.act('copy-diag')
  assert.equal(texts.length, 1)
  assert.equal(texts[0].includes('\n'), false, '单行无换行')
  assert.match(texts[0], /\[update-diag\] code=install-failed/, '单行带 code=')
  panel.unmount()
})
