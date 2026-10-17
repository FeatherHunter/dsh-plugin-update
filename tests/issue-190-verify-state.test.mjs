/**
 * tests/issue-190-verify-state.test.mjs —— 「成功」口径一处真源 + 在册事实（#190，S3）。
 *
 * 钉死的契约（#190 修形：磁盘 / 运行 / 在册三事实算出的状态一处真源，文案与事实同口径）：
 * 1. 装完运行版已经换成目标版（HMR / 即时生效）⇒ 任务状态、verify 日志、面板三处都必须是
 *    `completed`；不许再出现「日志说 completed、任务却硬编码 restart-required」的第三种口径。
 * 2. 运行版还是旧的 ⇒ 三处一致：任务 restart-required、verify result=restart-required /
 *    pendingRestart=true、快照 blockedReason=pending-restart、面板待重启横幅。
 * 3. 装前就没登记、按 #201 的「登记不许倒退」通道装成功 ⇒ 快照必须带 registered=false，
 *    面板/批量文案点明「重启宿主不会加载」，不许再说「重启宿主后生效」。
 * 4. 正常登记 ⇒ 旧文案保持不变（回归）。
 *
 * 只测外部行为（公开电话/核心方法/渲染函数），网络与执行全用假件，不碰真机。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createUpdateCore } from '../dist/service.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { panelViewModel } from '../dist/panel.js'
import { renderBatchPanelHTML } from '../dist/panel-batch.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'C'.repeat(86) + '=='
const OLD = '1.0.0'
const NEW = '2.0.0'

function releaseBody(version) {
  return JSON.stringify({
    name: TARGET,
    version,
    engines: { node: '>=22' },
    dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${version}.tgz`, integrity: INTEGRITY },
  })
}

function fakeLatest(version = NEW) {
  return async (url) => {
    assert.equal(url, `${REGISTRY}${encodeURIComponent(TARGET)}/latest`)
    return { ok: true, headers: { get: () => null }, text: async () => releaseBody(version) }
  }
}

function memoryJobStore() {
  let job = null
  const writes = []
  return {
    readJob: async () => job,
    writeJob: async (value) => {
      job = value
      if (value && typeof value.state === 'string') writes.push(value.state)
    },
    tryAcquireLock: async () => true,
    releaseLock: async () => {},
    backupJob: async () => {},
    peek: () => job,
    writes: () => writes.slice(),
  }
}

/**
 * 核心级假件：`readRunningVersion` / `readInstalled` 都读可变引用，
 * `runInstall` 按场景把磁盘版本（和可选的运行版本）改掉，模拟装完的现场。
 */
function makeCore({ installed = OLD, running = OLD, registered = true, moveRunning = false } = {}) {
  const refs = { installed, running }
  const store = memoryJobStore()
  const fires = []
  let nextId = 0
  const core = createUpdateCore({
    readRunningVersion: () => refs.running,
    readInstalled: async () => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: null,
      profileDir: null,
      installedVersion: refs.installed,
      packageValid: true,
      sourceInstall: false,
      registered,
      blockedReason: null,
      installationKey: 'key-1',
      eligible: true,
    }),
    fetchImpl: fakeLatest(),
    now: () => 1_000_000,
    randomId: () => `id-${(nextId += 1)}`,
    nodeVersion: '22.0.0',
    readJob: store.readJob,
    writeJob: store.writeJob,
    tryAcquireLock: store.tryAcquireLock,
    releaseLock: store.releaseLock,
    backupJob: store.backupJob,
    emitLog: (level, event, fields) => fires.push({ level, event, fields }),
    runInstall: async ({ version }) => {
      refs.installed = version
      if (moveRunning) refs.running = version
    },
  })
  return { core, refs, store, fires }
}

async function installOne(core) {
  const checked = await core.check()
  assert.equal(checked.snapshot.canInstall, true, '前置：这一步应当可装')
  assert.ok(checked.receipt && typeof checked.receipt.checkId === 'string')
  await core.install({ checkId: checked.receipt.checkId, requestId: 'req-190' })
}

async function waitForEvent(fires, event, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    const hit = fires.find((row) => row.event === event)
    if (hit) return hit
    if (Date.now() - start > timeoutMs) throw new Error('等待事件超时：' + event)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function snapshotInput(snapshot) {
  return { snapshot, manual: null, queue: null, skippedLatest: false, lastError: null, errorKind: null }
}

// ---------- 1/2：核心级状态机 ----------
describe('#190 装后状态一处真源（核心）', () => {
  it('运行版已换成目标版：任务 completed、verify 一致、快照不判待重启、面板不画重启横幅', async () => {
    const { core, store, fires } = makeCore({ moveRunning: true })
    await installOne(core)
    const verify = await waitForEvent(fires, 'update.install.verify')
    assert.deepEqual(verify.fields, { result: 'completed', installedVersion: NEW, pendingRestart: false }, 'verify 必须说 completed')
    assert.equal(store.peek()?.state, 'completed', '任务持久状态必须与 verify 同口径（旧实现硬编码 restart-required）')
    assert.equal(store.writes().includes('restart-required'), false, '运行版已经换了，不许再写 restart-required')
    const snap = await core.status()
    assert.equal(snap.runningVersion, NEW)
    assert.equal(snap.blockedReason, null, '运行版==磁盘版==目标版，不该判 pending-restart')
    assert.equal(snap.registered, true, '快照要如实带在册事实')
    const view = panelViewModel(snapshotInput(snap), 'zh')
    assert.notEqual(view.banner.kind, 'restart', '面板不许画待重启横幅')
    assert.equal(view.banner.title.includes('重启宿主后生效'), false)
  })

  it('运行版还是旧的：任务 / verify / 快照 / 面板四处一致说待重启', async () => {
    const { core, store, fires } = makeCore({ moveRunning: false })
    await installOne(core)
    const verify = await waitForEvent(fires, 'update.install.verify')
    assert.deepEqual(verify.fields, { result: 'restart-required', installedVersion: NEW, pendingRestart: true })
    assert.equal(store.peek()?.state, 'restart-required')
    const snap = await core.status()
    assert.equal(snap.blockedReason, 'pending-restart')
    assert.equal(snap.registered, true)
    const view = panelViewModel(snapshotInput(snap), 'zh')
    assert.equal(view.banner.kind, 'restart')
    assert.ok(view.banner.title.includes('重启宿主后生效'), '正常登记：旧文案一字不变')
    assert.ok(view.banner.action.includes('重启宿主以加载新版本'))
  })
})

// ---------- 3/4：宿主级在册事实与文案 ----------
function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

function readProfile(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

function makeProfile({ bundles }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-190-'))
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: `^${OLD}` },
    ...(bundles !== undefined ? { dsh: { profile: { bundles } } } : {}),
  })
  return profileDir
}

function makeTargetPackage(dir, version) {
  writeJson(join(dir, 'package.json'), {
    name: TARGET,
    version,
    main: './index.js',
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './patch.js' } },
  })
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(join(dir, 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(dir, 'patch.js'), 'module.exports = {}\n')
}

/** 装前未登记（bundles:[]）或正常登记（bundles:[TARGET]）。 */
function makeHost(profileDir, { mode }) {
  const runInstall = async ({ version }) => {
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), version)
    const manifest = readProfile(profileDir)
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [TARGET]: version }
    if (mode === 'registered') {
      const profile = manifest.dsh?.profile ?? {}
      const bundles = Array.isArray(profile.bundles) ? profile.bundles : []
      if (!bundles.includes(TARGET)) manifest.dsh = { profile: { ...profile, bundles: [...bundles, TARGET] } }
    }
    writeJson(join(profileDir, 'package.json'), manifest)
  }
  return createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion: OLD,
        targetPackageDir: join(profileDir, 'node_modules', TARGET),
        profileDir,
        profileName: 'desktop',
        homeDir: profileDir,
        fetchImpl: fakeLatest(),
        now: () => 1_000_000,
        randomId: () => 'id-190',
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        runInstall,
        ...memoryJobStore(),
      },
    },
    { pluginId: 'issue190-plugin', prefix: 'issue190', targetPackageName: TARGET },
  )
}

async function installAndWait(host) {
  const check = await host.handlers['issue190.updateCheck']({})
  assert.equal(check.ok, true)
  await host.handlers['issue190.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-190-1' })
  const deadline = Date.now() + 15000
  for (;;) {
    const last = await host.handlers['issue190.updateStatus']({})
    assert.equal(last.ok, true)
    const state = last.snapshot.job ? last.snapshot.job.state : null
    if (state === 'restart-required' || state === 'completed' || state === 'failed') return last.snapshot
    if (Date.now() > deadline) throw new Error('安装 15 秒未收尾，最后状态=' + state)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const tmpRoots = []
beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('#190 在册事实让「重启后生效」不说满（宿主公开电话）', () => {
  it('装前未登记、装后仍未登记（#201 通道成功）：快照带 registered=false，面板改说「重启不会加载」', async () => {
    const profileDir = makeProfile({ bundles: [] })
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), OLD)
    const final = await installAndWait(makeHost(profileDir, { mode: 'unregistered' }))
    assert.equal(final.job.state, 'restart-required', '#201：这类包只有就地换版通道')
    assert.equal(final.registered, false, '快照必须带在册事实，面板才说得出实话')
    assert.equal(final.blockedReason, 'pending-restart')
    const view = panelViewModel(snapshotInput(final), 'zh')
    assert.equal(view.banner.kind, 'restart')
    assert.ok(view.banner.title.includes('未登记'), '标题要点明未登记')
    assert.equal(view.banner.title.includes('重启宿主后生效'), false, '不许再说过强的「重启后生效」')
    assert.ok(view.banner.action.includes('选中') || view.banner.action.includes('登记'), '下一步要可执行')
  })

  it('正常登记：快照 registered=true，旧文案一字不变（回归）', async () => {
    const profileDir = makeProfile({ bundles: [TARGET] })
    tmpRoots.push(profileDir)
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), OLD)
    const final = await installAndWait(makeHost(profileDir, { mode: 'registered' }))
    assert.equal(final.job.state, 'restart-required')
    assert.equal(final.registered, true)
    const view = panelViewModel(snapshotInput(final), 'zh')
    assert.equal(view.banner.kind, 'restart')
    assert.ok(view.banner.title.includes('重启宿主后生效'))
  })
})

// ---------- 5：批量面板同一口径 ----------
function batchRowOf(overrides = {}) {
  return {
    key: 'a',
    title: '甲插件',
    phase: 'done',
    targetVersion: NEW,
    restartRequired: true,
    error: null,
    snapshot: {
      runningVersion: OLD,
      installedVersion: NEW,
      latestVersion: NEW,
      canInstall: false,
      blockedReason: 'pending-restart',
      job: { state: 'restart-required', targetVersion: NEW },
      registered: true,
    },
    manual: null,
    queue: null,
    profileName: null,
    ...overrides,
  }
}

describe('#190 批量面板：未登记的行不把「重启后生效」说满', () => {
  it('一半登记一半未登记：横幅分别计数，未登记行的状态字点明「重启不会加载」', () => {
    const rows = [
      batchRowOf({ key: 'a', title: '甲插件', snapshot: { ...batchRowOf().snapshot, registered: true } }),
      batchRowOf({ key: 'b', title: '乙插件', snapshot: { ...batchRowOf().snapshot, registered: false } }),
    ]
    const dom = renderBatchPanelHTML({ rows, theme: 'archive', lang: 'zh' }).replace(/<style>[\s\S]*?<\/style>/, '')
    assert.ok(dom.includes('未登记'), '未登记的事实必须出现在面板里')
    assert.ok(dom.includes('未注册') === false)
    assert.ok(/1 个.*生效/.test(dom), '仍要如实说清有几个重启后生效')
    assert.ok(dom.includes('甲插件') && dom.includes('乙插件'))
    // #190：名单里要能看出是哪一家未登记（未登记的行带后缀），且重启按钮仍在（有已登记的行）。
    assert.ok(dom.includes('乙插件（未登记）'), '未登记的行要在名单里点名')
    assert.ok(dom.includes('乙插件（未登记）') && dom.includes('data-act="restart"'), '有已登记行时保留重启按钮')
  })

  it('全部未登记：横幅不许再说「重启宿主后生效」，也不给假的重启按钮/指令', () => {
    const rows = [batchRowOf({ key: 'b', title: '乙插件', snapshot: { ...batchRowOf().snapshot, registered: false } })]
    const dom = renderBatchPanelHTML({ rows, theme: 'archive', lang: 'zh' }).replace(/<style>[\s\S]*?<\/style>/, '')
    assert.equal(dom.includes('1 个已安装完成，重启宿主后生效。'), false, '全部未登记时旧句是假的')
    assert.ok(dom.includes('未登记'))
    // #190 硬修：全部未登记时重启不会加载任何东西——重启按钮与「重启以加载新版本」的指令都不许出现。
    assert.equal(dom.includes('data-act="restart"'), false, '全部未登记时不画重启按钮')
    assert.equal(dom.includes('请重启DSH'), false, '全部未登记时不给假的按钮文案')
    assert.equal(dom.includes('重启宿主以加载新版本'), false, '全部未登记时不给假的下一步')
    assert.ok(dom.includes('先在宿主插件页选中'), '要给真实可执行的下一步')
    // #190 硬修：一句话总账与印章也要跟总账同口径，不能上面写「已全部为最新」下面挂未登记横幅。
    assert.equal(dom.includes('已全部为最新，无需操作。'), false, '全部未登记时总账不许说「已全部为最新」')
    assert.ok(dom.includes('已安装但未登记'), '总账要如实点出未登记的数')
    assert.ok(dom.includes('另有 1 个未登记'), '分类总账要记「未登记」这一档')
    assert.ok(dom.includes('data-seal-tone="yellow"'), '未登记也是待处理，印章不许落成灰的「没事」')
  })

  it('在册未知（null）：沿用原文案、不冒充未登记，重启按钮照旧', () => {
    const rows = [batchRowOf({ key: 'c', title: '丙插件', snapshot: { ...batchRowOf().snapshot, registered: null } })]
    const dom = renderBatchPanelHTML({ rows, theme: 'archive', lang: 'zh' }).replace(/<style>[\s\S]*?<\/style>/, '')
    assert.ok(dom.includes('1 个已安装完成，重启宿主后生效。'), '未知在册时沿用原文案')
    assert.equal(dom.includes('未登记'), false, '未知不许冒充未登记')
    assert.ok(dom.includes('data-act="restart"'), '未知在册时重启按钮照旧')
  })
})
