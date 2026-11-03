/**
 * tests/issue-284-not-installable.test.mjs —— #284 第二面真机 BUG 回归：有新版但当前装不了时，
 * 面板/诊断不得借 done 兜底谎称「已是最新」。
 *
 * 现场（真机 run 284-20261103T180549，L1 同进程两插件并发）：fxa-a 装成 0.0.2 后，fxb-b 的安装被队列门
 * 拒（stage=gate reason=gate-refused code=update-busy，磁盘仍 0.0.1、无 b 台账）；但 fxb-b 的
 * update.check.done 明写 current=0.0.1 latest=0.0.2，几秒后它的面板却显示「已是最新，无需更新。」。
 * 根因：A 的安装改写了共享使用范围 → src/core/reader.ts:411-422 的 installationKey 变了 →
 * src/core/service.ts:486-493 的 canInstall 因此为 false（checked.installationKey !== env.installationKey），
 * 但 snapshot.latestVersion 仍取 checked.release.version（service.ts:512）= 0.0.2；blockedReason=null、
 * 无 job → src/panel/view-model.ts 旧 done 兜底把「有新版但装不了」写成「已是最新」。服务层
 * statusVerdictOf（service.ts:534-551）同刻仍判 update-available——两套口径打架。诊断复制
 * src/shared/copy.ts buildHealthyDiagCopy 的 stateLine 有同一句假话。
 * 修法：两处都在 done 兜底前加：latest 非空 && running 非空 && compareReleaseVersions(latest, running) === 1
 * （能装分支已在前 return，走到这里是「知道有新版、当前装不了」）→ 诚实 idle 档 + 「检查更新」入口；
 * 其余组合（可装 / latest==running / latest<running / blocked / job / 未安装 / latest 未知）逐字不变。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { panelViewModel } from '../dist/panel.js'
import { buildHealthyDiagCopy } from '../dist/shared/copy.js'

function snapshotOf(overrides = {}) {
  return {
    installed: true,
    runningVersion: '0.0.1',
    installedVersion: '0.0.1',
    latestVersion: '0.0.2',
    canInstall: false,
    blockedReason: null,
    job: null,
    identity: 'update',
    registered: true,
    ...overrides,
  }
}

function viewOf(snapshot, lang = 'zh') {
  return panelViewModel({ snapshot, manual: null, queue: null, skippedLatest: false, lastError: null }, lang)
}

function diagOf(overrides = {}, lang = 'zh') {
  return buildHealthyDiagCopy({
    canInstall: false,
    latestVersion: '0.0.2',
    installed: true,
    runningVersion: '0.0.1',
    installedVersion: '0.0.1',
    queuePosition: null,
    pluginId: 'fixture-b',
    hostKind: 'desktop',
    profileName: 'desktop',
    requestId: null,
    checkId: null,
    lang,
    ...overrides,
  })
}

describe('#284 第二面：有新版但当前装不了时不得谎称已是最新', () => {
  it('正向：latest=0.0.2 比运行版新但 canInstall=false → 面板诚实 idle，不说已是最新', () => {
    const zh = viewOf(snapshotOf(), 'zh')
    assert.notEqual(zh.banner.kind, 'done', '有新版且磁盘没变时不得落 done（真机 180549 的假话）')
    assert.equal(zh.banner.kind, 'idle', '诚实档：不是 blocked（没产品阻挡原因）、更不是已完成')
    assert.match(zh.banner.title, /有新版本 0\.0\.2/, '要照实说有新版：中文')
    assert.match(zh.banner.title, /当前无法安装/, '要照实说当前装不了：中文')
    assert.doesNotMatch(zh.banner.title, /已是最新/, '不得出现「已是最新」')
    assert.equal(zh.banner.action, '检查更新', '给自愈入口：重新检查更新')
    assert.equal(zh.installEnabled, false, '结论已不可装，不能给安装按钮')
    assert.equal(zh.showReset, false)

    const en = viewOf(snapshotOf(), 'en')
    assert.notEqual(en.banner.kind, 'done', '英文同一守卫：不得落 done')
    assert.match(en.banner.title, /Newer version 0\.0\.2/)
    assert.match(en.banner.title, /cannot be installed right now/i)
    assert.doesNotMatch(en.banner.title, /Up to date/i)
  })

  it('正向：诊断复制同组合 → 诚实新文案，不含「已是最新」', () => {
    const zh = diagOf({}, 'zh')
    assert.match(zh, /\[update-diag\] 当前无失败：有新版本 0\.0\.2，但当前无法安装；请重新检查更新后重试。/)
    assert.doesNotMatch(zh, /已是最新/)
    const en = diagOf({}, 'en')
    assert.match(en, /Newer version 0\.0\.2 is available, but it cannot be installed right now/)
    assert.doesNotMatch(en, /Up to date/i)
  })

  it('反向：能装（canInstall=true）→ update 分支逐字不变', () => {
    const zh = viewOf(snapshotOf({ canInstall: true }), 'zh')
    assert.equal(zh.banner.kind, 'update')
    assert.equal(zh.installEnabled, true)
    assert.match(zh.banner.title, /有新版本 0\.0\.2 可安装（当前版本 0\.0\.1）/)
    const diag = diagOf({ canInstall: true })
    assert.match(diag, /当前无失败：有新版 0\.0\.2 可装（当前 0\.0\.1）/)
  })

  it('反向：latest 等于运行版（合法「已是最新」）→ 仍说已是最新', () => {
    const zh = viewOf(snapshotOf({ latestVersion: '0.0.1' }), 'zh')
    assert.equal(zh.banner.kind, 'done')
    assert.match(zh.banner.title, /已是最新/)
    assert.match(diagOf({ latestVersion: '0.0.1' }), /当前无失败：已是最新，无需更新。/)
  })

  it('反向：latest 比运行版旧（倒挂）→ 仍说已是最新，不被新分支抢走', () => {
    const snapshot = snapshotOf({ runningVersion: '0.0.2', installedVersion: '0.0.2', latestVersion: '0.0.1' })
    const zh = viewOf(snapshot, 'zh')
    assert.equal(zh.banner.kind, 'done')
    assert.match(zh.banner.title, /已是最新/)
    assert.match(diagOf({ runningVersion: '0.0.2', installedVersion: '0.0.2', latestVersion: '0.0.1' }), /当前无失败：已是最新，无需更新。/)
  })

  it('反向：有产品阻挡原因 → blocked 分支在前，new not-installable 分支不吞它', () => {
    const zh = viewOf(snapshotOf({ blockedReason: 'installation-changed' }), 'zh')
    assert.equal(zh.banner.kind, 'blocked')
    assert.doesNotMatch(zh.banner.title, /当前无法安装；请重新检查更新后重试/)
  })

  it('反向：在途任务 → busy 分支在前，new not-installable 分支不吞它', () => {
    const job = { id: 'j1', state: 'installing', targetVersion: '0.0.2', message: '' }
    const zh = viewOf(snapshotOf({ job, canInstall: false }), 'zh')
    assert.equal(zh.banner.kind, 'busy')
  })

  it('反向：未安装（installed=false）→ 未安装档在前，不被新分支抢走', () => {
    const snapshot = snapshotOf({ installed: false, installedVersion: null, runningVersion: null })
    const zh = viewOf(snapshot, 'zh')
    assert.equal(zh.banner.kind, 'idle')
    assert.match(zh.banner.title, /未安装/)
    assert.doesNotMatch(zh.banner.title, /当前无法安装/)
  })

  it('反向：latest 未知 → 上一面的未知档在前，new not-installable 分支不吞它', () => {
    const zh = viewOf(snapshotOf({ latestVersion: null }), 'zh')
    assert.equal(zh.banner.kind, 'idle')
    assert.match(zh.banner.title, /版本信息未知/)
  })
})
