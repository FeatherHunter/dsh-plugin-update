/**
 * tests/issue-134-panel-not-installed.test.mjs —— #134 切片2：双面板未装态。
 *
 * 只测外部行为/产物：渲染出来的用户可见文案、公开 view-model 的分支。
 * 不直调内部函数（batchRowVersionHTML 未导出就断 renderBatchPanelHTML 的 HTML 子串，
 * batchRowVersionParts 形状冻结只读现行值）、不断言私有状态。
 *
 * 词表依据（#137 键级差异）：批量版本左值用新增 `batch.row.not-installed`「未安装」，
 * 单插件状态词用新增 `panel.banner.not-installed`「未安装」；动作词沿用既有键，不新造。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  batchRowStatus,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js'
import { panelViewModel } from '../dist/panel.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

/** 缺席快照：一等事实 installed=false，运行版号是集成方注入的假值（US19）。 */
function absentSnap(over = {}) {
  return {
    runningVersion: '0.0.0',
    installed: false,
    installedVersion: null,
    latestVersion: '0.3.54',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...over,
  }
}

function rowOf(o = {}) {
  return {
    key: 'a', title: '饼干记账', phase: 'ready', targetVersion: null,
    restartRequired: false, error: null, snapshot: null, manual: null,
    queue: null, profileName: null, pluginId: null, diag: null, hostKind: null, ...o,
  }
}

/** 缺席账本条目：installedVersion 为 null（不再回退运行版号），error 为空。 */
function absentEntry(over = {}) {
  return {
    lastCheckedAt: 1, installed: false, installedVersion: null,
    latestVersion: '0.3.54', canInstall: true, error: null, ...over,
  }
}

function rowMainOf(html, key) {
  const at = html.indexOf('data-key="' + key + '"')
  assert.ok(at >= 0, key + ' 行要有')
  const mainAt = html.indexOf('dsh-upd-brow-main', at)
  return html.slice(mainAt, mainAt + 1600)
}

describe('批量行版本列：未装说人话，不说哨兵版号（US1）', () => {
  it('zh：版本列是「未安装 → 0.3.54」，不见 0.0.0', () => {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ snapshot: absentSnap() })],
      inventory: { version: 1, updatedAt: 1, entries: { a: absentEntry() } },
      lang: 'zh',
    })
    const main = rowMainOf(html, 'a')
    assert.ok(main.includes('未安装'), '左值是人话「未安装」')
    assert.ok(main.includes('0.3.54'), '右值是目标版本')
    assert.ok(!main.includes('0.0.0'), '注入的假版号不得出现在版本列')
    assert.ok(main.includes('dsh-upd-bver-new">0.3.54'), '新版走红段')
  })

  it('en：版本列是「Not installed → 0.3.54」', () => {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ snapshot: absentSnap() })],
      inventory: { version: 1, updatedAt: 1, entries: { a: absentEntry() } },
      lang: 'en',
    })
    const main = rowMainOf(html, 'a')
    assert.ok(main.includes('Not installed'), '英文左值')
    assert.ok(!main.includes('0.0.0'), '英文下假版号同样不得出现')
  })

  it('会话目标版路径同样说人话：未安装 → 会话目标', () => {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ targetVersion: '0.3.54', snapshot: absentSnap() })],
      lang: 'zh',
    })
    const main = rowMainOf(html, 'a')
    assert.ok(main.includes('未安装'), '会话目标路径左值也是人话')
    assert.ok(!main.includes('0.0.0'), '会话目标路径同样不见假版号')
  })
})

describe('批量行失败文案分家：查侧说查询，装侧才说安装失败', () => {
  function failedMain(code) {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ phase: 'failed', error: code, snapshot: absentSnap({ canInstall: false }) })],
      lang: 'zh',
    })
    return rowMainOf(html, 'a')
  }

  for (const code of ['check-failed', 'invalid-release', 'check-expired']) {
    it(`查侧码 ${code}：行说「本次未能查询」，不说安装失败`, () => {
      const main = failedMain(code)
      assert.ok(main.includes('本次未能查询'), code + ' 走查侧文案')
      assert.ok(!main.includes('安装失败'), code + ' 不得说安装失败')
    })
  }

  it('装侧码 install-failed：仍说「安装失败，请选择「重试」。」（分家另一半）', () => {
    const main = failedMain('install-failed')
    assert.ok(main.includes('安装失败，请选择「重试」。'), '装侧文案不动')
  })

  it('无码失败：回退装侧文案（旧快照不动）', () => {
    assert.equal(batchRowStatus(rowOf({ phase: 'failed' }), null, 'zh'), '安装失败，请选择「重试」。')
  })
})

describe('批量行其他未装口径（搭车不断言分支，只钉不塌）', () => {
  it('目标版本曾被跳过：未装行走恢复入口，不装', () => {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ snapshot: absentSnap() })],
      skippedVersions: { a: '0.3.54' },
      lang: 'zh',
    })
    const main = rowMainOf(html, 'a')
    assert.ok(main.includes('恢复提醒（0.3.54）'), '跳过账按版本共用，未装一样走恢复')
    assert.ok(!main.includes('安装此插件'), '跳过后不再给安装按钮')
  })

  it('pending + 缺席知识：不报「已是最新」，报有新版', () => {
    const html = renderBatchPanelHTML({
      rows: [rowOf({ phase: 'pending', snapshot: absentSnap({ canInstall: false, latestVersion: null }) })],
      session: { version: 1, id: 's', selfKey: null, stopOnFailure: false, order: [], entries: [], createdAt: 0, updatedAt: 0 },
      inventory: { version: 1, updatedAt: 1, entries: { a: absentEntry() } },
      lang: 'zh',
    })
    const main = rowMainOf(html, 'a')
    assert.ok(!main.includes('已是最新'), '未装永不说已是最新（US16）')
    assert.ok(main.includes('有新版本 0.3.54'), 'pending 知识态报有新版')
  })
})

describe('批量端到端：未装行不再落失败相位（US10）', () => {
  function wj(p, o) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(o, null, 2) + '\n')
  }

  it('batchCheck 收敛知识：installed=false、installedVersion=null、error 为空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'issue-134-batch-'))
    wj(join(dir, 'package.json'), { name: 'fake-profile', version: '0.0.0', dependencies: { 'pkg-a': '2.0.0' } })
    const host = createMultiHostUpdate(
      {
        scope: { homeDir: dir, profileDir: dir },
        // 批量宿主不替调用方猜目录（issue #3）：profileDir/homeDir 由调用方按家给出。
        readerOverridesFor: () => ({ profileName: 'web', runningVersion: '0.0.0', homeDir: dir, profileDir: dir }),
        transport: {
          check: async () => ({ kind: 'update', version: '2.0.0' }),
          install: async () => ({ kind: 'done', restartRequired: false }),
        },
      },
      { prefix: 'life', targets: [{ key: 'a', title: '甲', packageName: 'pkg-a', prefix: 'p-a' }] },
    )
    // 面板先读状态（行快照就位），再查：知识收敛与行内快照同步。
    const status = await host.handlers['life.batchStatus']({})
    assert.equal(status.rows[0].snapshot.installed, false, '行快照先有在场事实')
    const reply = await host.handlers['life.batchCheck']({})
    assert.equal(reply.ok, true)
    const entry = reply.inventory.entries.a
    assert.equal(entry.error, null, '未装行知识无 error')
    assert.equal(entry.installed, false, '账本记在场事实')
    assert.equal(entry.installedVersion, null, '账本不再回退运行版号')
    assert.equal(entry.latestVersion, '2.0.0')
    host.dispose()
  })

  it('batchInstall 一次装上：缺席包从无到有，不落 failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'issue-134-binstall-'))
    wj(join(dir, 'package.json'), { name: 'fake-profile', version: '0.0.0', dependencies: { 'pkg-a': '2.0.0' } })
    const host = createMultiHostUpdate(
      {
        scope: { homeDir: dir, profileDir: dir },
        transport: {
          check: async () => ({ kind: 'update', version: '2.0.0' }),
          install: async () => {
            // 假安装出口落盘（与真安装同构：写依赖声明的包 + 三个入口文件）。
            wj(join(dir, 'package.json'), { name: 'fake-profile', version: '0.0.0', dependencies: { 'pkg-a': '2.0.0' } })
            wj(join(dir, 'node_modules', 'pkg-a', 'package.json'), { name: 'pkg-a', version: '2.0.0' })
            writeFileSync(join(dir, 'node_modules', 'pkg-a', 'index.js'), 'm={}\n')
            return { kind: 'done', restartRequired: false }
          },
        },
      },
      { prefix: 'life', targets: [{ key: 'a', title: '甲', packageName: 'pkg-a', prefix: 'p-a' }] },
    )
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const entry = reply.session.entries.find((e) => e.key === 'a')
    assert.ok(entry, '有会话行')
    assert.notEqual(entry.phase, 'failed', '未装行不再落失败相位（US10）')
    host.dispose()
  })
})

describe('单插件面板未装态（US8/US15/US16）', () => {
  function vm(snapshot, over = {}) {
    return panelViewModel(
      { snapshot, manual: null, queue: null, skippedLatest: false, lastError: null, ...over },
      'zh',
    )
  }

  it('查完可装：横幅非 done、按钮「安装版本 0.3.54」、标题说未安装不见假版号', () => {
    const view = vm(absentSnap())
    assert.equal(view.banner.kind, 'update')
    assert.equal(view.installEnabled, true)
    assert.equal(view.installLabel, '安装版本 0.3.54')
    assert.ok(view.banner.title.includes('未安装'), '标题说未安装')
    assert.ok(view.banner.title.includes('0.3.54'), '标题带目标版本')
    assert.ok(!view.banner.title.includes('0.0.0'), '标题不见注入假版号')
  })

  it('还没检查：不落 done「已是最新」，kind idle + 未装状态词 + 按钮不可点', () => {
    const view = vm(absentSnap({ latestVersion: null, canInstall: false }))
    assert.notEqual(view.banner.kind, 'done', '未装永不说已是最新（US16）')
    assert.equal(view.banner.kind, 'idle')
    assert.ok(view.banner.title.includes('未安装'), '未装状态词')
    assert.equal(view.installEnabled, false, '需先检查，按钮不可点')
  })

  it('查不到远程版本：未装状态词 + 查侧文案，不说安装失败', () => {
    const view = vm(absentSnap({ latestVersion: null, canInstall: false }), { lastError: 'check-failed' })
    assert.equal(view.banner.kind, 'failed')
    assert.ok(view.banner.title.includes('未安装'), '未装状态词打头')
    assert.ok(view.banner.title.includes('版本信息查询失败'), '查侧文案保留')
    assert.ok(!view.banner.title.includes('安装失败'), '查失败不说安装失败（US15）')
  })

  it('在场回归：标题仍用运行版号（旧行为不塌）', () => {
    const view = vm({
      runningVersion: '1.0.0', installed: true, installedVersion: '1.0.0',
      latestVersion: '1.1.0', canInstall: true, blockedReason: null, job: null,
    })
    assert.equal(view.banner.kind, 'update')
    assert.ok(view.banner.title.includes('1.0.0'), '在场标题用运行版号')
    assert.ok(!view.banner.title.includes('未安装'), '在场不说未安装')
  })
})
