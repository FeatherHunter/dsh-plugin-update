/**
 * tests/issue-284-unknown-latest.test.mjs —— #284 真机暴露的产品 BUG 回归：最新版未知时不许谎称「已是最新」。
 *
 * 现场（真机 run 284-20261103T151900）：同一进程里 fxa-a 的安装被跨插件队列 gate 拒（磁盘仍 0.0.1、
 * updates/ 下没有 fxa-a 台账），面板却显示「已是最新，无需更新。」；同刻 A 的日志是
 * status.changed unknown latest=null unknownCause=no-latest。根因：host/capabilities.ts 的读取器单例
 * 被别的目标轮询挤掉后新建实例，checked 丢失 → src/core/service.ts:512 latestVersion=null，
 * 服务层已诚实地判 unknown/no-latest（:534-551），但 src/panel/view-model.ts:388 的 done 兜底把
 * 「不知道」写成了「已是最新」；src/shared/copy.ts buildHealthyDiagCopy 的 stateLine 有同一句假话
 * （复制诊断可见）。修法：两处在同一守卫（installed !== false && latestVersion === null）下改说
 * 「版本信息未知，请检查更新」，其余分支逐字不变。
 *
 * 断言口径：
 *  1) 正向：运行版已知、磁盘已装、未查到最新版 → 面板 banner 不是 done、两语言都不含「已是最新/Up to date」；
 *     诊断复制同组合 → 未知档文案、不含「已是最新」。
 *  2) 反向：最新版已知且可装 → update 分支不变；最新版已知且等于运行版（合法「已是最新」）→ done/已是最新不变。
 *  3) 反向：未安装（installed === false）→ 仍走「未安装」档，不被新分支抢走。
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
    latestVersion: null,
    canInstall: false,
    blockedReason: null,
    job: null,
    identity: 'update',
    registered: true,
    ...overrides,
  }
}

function viewOf(snapshot, lang = 'zh', manual = null) {
  return panelViewModel({ snapshot, manual, queue: null, skippedLatest: false, lastError: null }, lang)
}

function diagOf(overrides = {}, lang = 'zh') {
  return buildHealthyDiagCopy({
    canInstall: false,
    latestVersion: null,
    installed: true,
    runningVersion: '0.0.1',
    installedVersion: '0.0.1',
    queuePosition: null,
    pluginId: 'fixture-a',
    hostKind: 'desktop',
    profileName: 'desktop',
    requestId: null,
    checkId: null,
    lang,
    ...overrides,
  })
}

describe('#284：最新版未知时面板/诊断不得谎称已是最新', () => {
  it('正向：latestVersion=null 且已装（运行版已知）→ 面板给未知档，不说已是最新', () => {
    const zh = viewOf(snapshotOf(), 'zh')
    assert.notEqual(zh.banner.kind, 'done', '未查到最新版不得落 done（「已是最新」）')
    assert.equal(zh.banner.kind, 'idle', '诚实档：没信息就是没信息（不是 blocked：不是装不了）')
    assert.match(zh.banner.title, /版本信息未知/, '中文要说不知道，而不是断言已是最新')
    assert.doesNotMatch(zh.banner.title, /已是最新/)
    assert.equal(zh.installEnabled, false, '不知道最新版时不能给「安装」动作')
    assert.equal(zh.banner.action, '检查更新')
    assert.equal(zh.showReset, false)

    const en = viewOf(snapshotOf(), 'en')
    assert.notEqual(en.banner.kind, 'done', '英文同一守卫：不得落 done')
    assert.match(en.banner.title, /Version information unknown/)
    assert.doesNotMatch(en.banner.title, /Up to date/i)
  })

  it('正向：诊断复制同组合 → 未知档文案，不含「已是最新」', () => {
    const zh = diagOf({}, 'zh')
    assert.match(zh, /\[update-diag\] 当前无失败：版本信息未知，请先检查更新。/)
    assert.doesNotMatch(zh, /已是最新/)
    const en = diagOf({}, 'en')
    assert.match(en, /Version information unknown; check for updates first\./)
    assert.doesNotMatch(en, /Up to date/i)
  })

  it('反向：最新版已知且可装 → update 分支逐字不变', () => {
    const snapshot = snapshotOf({ latestVersion: '0.0.2', canInstall: true })
    const zh = viewOf(snapshot, 'zh')
    assert.equal(zh.banner.kind, 'update')
    assert.equal(zh.installEnabled, true)
    const diag = diagOf({ latestVersion: '0.0.2', canInstall: true })
    assert.match(diag, /当前无失败：有新版 0\.0\.2 可装（当前 0\.0\.1）/)
  })

  it('反向：最新版已知且等于运行版（合法「已是最新」）→ 仍说已是最新', () => {
    const snapshot = snapshotOf({ latestVersion: '0.0.1', canInstall: false })
    const zh = viewOf(snapshot, 'zh')
    assert.equal(zh.banner.kind, 'done')
    assert.match(zh.banner.title, /已是最新/)
    const diag = diagOf({ latestVersion: '0.0.1', canInstall: false })
    assert.match(diag, /当前无失败：已是最新，无需更新。/)
  })

  it('反向：未安装（installed=false）→ 仍走未安装档，不被新守卫抢走', () => {
    const snapshot = snapshotOf({ installed: false, installedVersion: null, canInstall: false })
    const zh = viewOf(snapshot, 'zh')
    assert.equal(zh.banner.kind, 'idle')
    assert.match(zh.banner.title, /未安装/)
    assert.doesNotMatch(zh.banner.title, /版本信息未知/)
  })
})
