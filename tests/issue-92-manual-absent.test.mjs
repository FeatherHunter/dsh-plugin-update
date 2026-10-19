/**
 * tests/issue-92-manual-absent.test.mjs —— #92：手工命令为空时按原因说清，不再一句含糊话。
 *
 * 缝（外部行为）：
 * - 分类纯函数 `manualAbsentReasonOf(snapshot)`（dist/shared/manual-absent.js）；
 * - 单插件面板 05 章（renderUpdatePanelKernel）；批量面板横幅置灰 title 与聚合注释行
 *   （renderBatchPanelHTML / batchFailedManualText）。
 *
 * 政策边界（本票只改话术，不改给命令的规则）：源码安装 / 开发态 / 范围认不出 /
 * 运行版未知 / 没有安全候选这五类仍不给命令（#98 不降级、#153 不覆盖源码安装、
 * #182 运行版未知不猜、#201 命令必须可执行）；本文件只断言「说清了为什么」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { manualAbsentReasonOf } from '../dist/shared/manual-absent.js'
import { panelViewModel, renderUpdatePanelKernel } from '../dist/panel.js'
import { batchFailedManualText, renderBatchPanelHTML } from '../dist/panel-batch.js'

const OLD_COPY = '当前没有可用的手工命令（使用范围无法识别或源码安装场景不提供）'
const FALLBACK_ZH = '当前没有可用的手工命令。'

function snapshotOf(overrides = {}) {
  return {
    installed: true,
    runningVersion: '1.7.45',
    installedVersion: '1.7.45',
    latestVersion: '1.7.46',
    canInstall: true,
    blockedReason: null,
    job: null,
    identity: 'update',
    registered: true,
    ...overrides,
  }
}

function viewOf(snapshot, manual = null, lastError = null) {
  return panelViewModel({ snapshot, manual, queue: null, skippedLatest: false, lastError }, 'zh')
}

function renderOf(snapshot, manual = null, lastError = null, lang = 'zh') {
  const view = panelViewModel({ snapshot, manual, queue: null, skippedLatest: false, lastError }, lang)
  return renderUpdatePanelKernel(
    {
      snapshot,
      manual,
      queue: null,
      skippedLatest: false,
      lastError,
      mode: 'embedded',
      showOthers: false,
      pluginId: 'p',
      copyNotice: null,
      lang,
    },
    view,
  )
}

function chapter05(html) {
  const at = html.indexOf('data-chapter="05"')
  assert.ok(at >= 0, '05 章恒在：' + html.slice(0, 400))
  return html.slice(at)
}

function rowOf(overrides = {}) {
  return {
    key: 'a',
    title: '甲插件',
    phase: 'failed',
    targetVersion: '2.0.0',
    restartRequired: false,
    error: 'install-failed',
    snapshot: snapshotOf(),
    manual: null,
    queue: null,
    profileName: null,
    ...overrides,
  }
}

describe('#92 分类：先查快照里的原因，判不出才落到「没有安全候选」', () => {
  it('三类阻塞原因直接采用快照的 blockedReason', () => {
    assert.equal(manualAbsentReasonOf(snapshotOf({ blockedReason: 'unknown-profile', canInstall: false })), 'unknown-profile')
    assert.equal(manualAbsentReasonOf(snapshotOf({ blockedReason: 'source-install', canInstall: false })), 'source-install')
    assert.equal(manualAbsentReasonOf(snapshotOf({ blockedReason: 'dev-source', canInstall: false })), 'dev-source')
  })

  it('运行版未知（#182）单独成一类，不并进「没有安全候选」', () => {
    assert.equal(manualAbsentReasonOf(snapshotOf({ runningVersion: null, canInstall: false })), 'running-unknown')
    // 空串在 manualCommand 里同样按未知处理，分类跟着同一口径走。
    assert.equal(manualAbsentReasonOf(snapshotOf({ runningVersion: '', canInstall: false })), 'running-unknown')
    // 外部旧快照可能连这一格都没有：那是判不出，不是「未知已知」——回兜底，不硬编原因。
    assert.equal(manualAbsentReasonOf(snapshotOf({ runningVersion: undefined, canInstall: false })), null)
  })

  it('其余（含无快照）落到兜底：无快照回 null，有快照回 no-safe-candidate', () => {
    assert.equal(manualAbsentReasonOf(null), null, '没有快照 = 判不出，回兜底')
    assert.equal(manualAbsentReasonOf(undefined), null)
    assert.equal(manualAbsentReasonOf(snapshotOf({ blockedReason: 'recovery-required', canInstall: false })), 'no-safe-candidate')
    assert.equal(manualAbsentReasonOf(snapshotOf()), 'no-safe-candidate')
  })
})

describe('#92 单插件 05 章：每类空态说清原因与下一步，旧含糊话一处不剩', () => {
  const cases = [
    ['unknown-profile', snapshotOf({ blockedReason: 'unknown-profile', canInstall: false }), /认不出插件所在的使用范围/, /重启宿主后重新查询/],
    ['source-install', snapshotOf({ blockedReason: 'source-install', canInstall: false }), /源码安装/, /重新安装/],
    ['dev-source', snapshotOf({ blockedReason: 'dev-source', canInstall: false }), /开发态挂载/, /重启宿主/],
    ['running-unknown', snapshotOf({ runningVersion: null, canInstall: false }), /读不到正在运行的版本号/, /重启宿主/],
    ['no-safe-candidate', snapshotOf(), /没有可安全执行的目标版本/, /第 5\.2 节/],
  ]
  for (const [name, snapshot, cause, next] of cases) {
    it(name + '：05 章点名原因并给下一步', () => {
      const html = renderOf(snapshot)
      const five = chapter05(html)
      assert.match(five, cause, name + ' 原因没写进 05 章：' + five.slice(0, 400))
      assert.match(five, next, name + ' 下一步没写进 05 章')
      assert.ok(!html.includes(OLD_COPY), name + ' 旧含糊话还在')
      assert.ok(!/一定能给出|总会给出|总有办法/.test(html), name + ' 不许承诺总能给命令')
    })
  }

  it('英文语言下 05 章同样分因（不是只有中文）', () => {
    const html = renderOf(snapshotOf({ blockedReason: 'source-install', canInstall: false }), null, null, 'en')
    const five = chapter05(html)
    assert.match(five, /installed from source/, 'en 原因：' + five.slice(0, 400))
    assert.match(five, /reinstall/i, 'en 下一步')
    assert.ok(!five.includes('No manual command is available right now. No safe target version'), 'en 不硬套「没有安全候选」')
  })

  it('有命令时照旧展示命令，不画任何「没有手工命令」的原因话术', () => {
    const manual = 'dsh plugin --profile web add --save-exact p@1.7.46 --registry=https://registry.npmjs.org/'
    const html = renderOf(snapshotOf(), manual)
    assert.ok(chapter05(html).includes(manual), '命令原文要在')
    assert.ok(!chapter05(html).includes(FALLBACK_ZH), '有命令时不说没有命令')
    assert.ok(!chapter05(html).includes('没有可安全执行的目标版本'), '有命令时不讲空态原因')
  })

  it('判不出原因的旧状态（无快照失败）仍给兜底句，且旧含糊话不出现', () => {
    const html = renderOf(null, null, 'install-failed')
    assert.ok(chapter05(html).includes(FALLBACK_ZH), '兜底句在')
    assert.ok(!html.includes(OLD_COPY), '旧含糊话不许出现')
    assert.ok(!chapter05(html).includes('没有可安全执行的目标版本'), '判不出原因就不编原因')
  })

  it('「已是最新」这类不涉及手工命令的状态不硬套空态原因', () => {
    const done = snapshotOf({ latestVersion: '1.7.45', canInstall: false })
    assert.equal(viewOf(done).banner.kind, 'done', '前提：已是最新')
    const html = renderOf(done)
    assert.ok(chapter05(html).includes(FALLBACK_ZH), '已最新时给中性兜底句')
    assert.ok(!chapter05(html).includes('没有可安全执行的目标版本'), '已最新不等于没有安全候选')
  })
})

describe('#92 批量面板：置灰 title 与聚合注释行按行原因说清', () => {
  const sourceRow = rowOf({ key: 'a', title: '甲插件', snapshot: snapshotOf({ blockedReason: 'source-install', canInstall: false }) })
  const unknownRow = rowOf({ key: 'b', title: '乙插件', snapshot: snapshotOf({ blockedReason: 'unknown-profile', canInstall: false }) })

  it('全部失败行原因一致：置灰 title 点名这个原因', () => {
    const sourceRow2 = rowOf({ key: 'c', title: '丙插件', snapshot: snapshotOf({ blockedReason: 'source-install', canInstall: false }) })
    const html = renderBatchPanelHTML({ rows: [sourceRow, sourceRow2], loaded: true, lang: 'zh' })
    assert.match(html, /data-act="copy-all-manual"[^>]*disabled/, '没有可执行命令要置灰')
    const titleAt = html.indexOf('data-act="copy-all-manual"')
    const title = html.slice(titleAt, titleAt + 1200)
    assert.match(title, /源码安装/, '置灰说明要带原因：' + title.slice(0, 400))
  })

  it('失败行原因混杂：置灰 title 给中性一句话，不把第一行的原因扣给整批', () => {
    const html = renderBatchPanelHTML({ rows: [sourceRow, unknownRow], loaded: true, lang: 'zh' })
    const titleAt = html.indexOf('data-act="copy-all-manual"')
    const title = html.slice(titleAt, titleAt + 1200)
    assert.ok(title.includes(FALLBACK_ZH), '混杂原因时用中性句：' + title.slice(0, 400))
    assert.ok(!/源码安装/.test(title), '混杂原因时不许点名某一行的原因：' + title.slice(0, 400))
  })

  it('聚合注释行：每家按自己的快照原因写，不是一句通用话', () => {
    const out = batchFailedManualText([sourceRow, unknownRow], 'zh')
    const lines = out.text.split(String.fromCharCode(10))
    assert.equal(out.commands, 0)
    assert.equal(lines.length, 2, '一行一家：' + JSON.stringify(out.text))
    assert.ok(lines[0].startsWith('# 甲插件：无手工命令（'), '第一行格式：' + lines[0])
    assert.match(lines[0], /源码安装/, '甲行原因：' + lines[0])
    assert.ok(lines[1].startsWith('# 乙插件：无手工命令（'), '第二行格式：' + lines[1])
    assert.match(lines[1], /认不出插件所在的使用范围/, '乙行原因：' + lines[1])
    assert.ok(!out.text.includes(OLD_COPY), '旧含糊话不许出现在可复制文本里')
  })

  it('有命令的行仍原样一行，只有缺命令的行带原因注释（回归）', () => {
    const withOne = [rowOf({ key: 'a', title: '甲插件', manual: 'npm i -g demo-a@2.0.0' }), rowOf({ key: 'b', title: '乙插件' })]
    const out = batchFailedManualText(withOne, 'zh')
    assert.equal(out.commands, 1)
    const lines = out.text.split(String.fromCharCode(10))
    assert.equal(lines[0], 'npm i -g demo-a@2.0.0', '命令逐字')
    assert.match(lines[1], /^# 乙插件：无手工命令（/, '缺命令的行仍用 # 注释占位：' + lines[1])
  })

  it('判不出原因的行：注释行写「原因未知」，不硬编原因、也不套整句抬头', () => {
    const legacySnapshot = snapshotOf()
    delete legacySnapshot.runningVersion
    const unknownReasonRow = rowOf({ key: 'c', title: '丙插件', snapshot: legacySnapshot })
    const out = batchFailedManualText([unknownReasonRow], 'zh')
    assert.equal(out.commands, 0)
    assert.equal(out.text, '# 丙插件：无手工命令（原因未知）', '判不出就如实说原因未知：' + JSON.stringify(out.text))
  })

  it('已知原因的注释行只写原因句，不重复「当前没有可用的手工命令」整句', () => {
    const out = batchFailedManualText([sourceRow], 'zh')
    assert.ok(out.text.startsWith('# 甲插件：无手工命令（'), out.text)
    assert.ok(!out.text.includes(FALLBACK_ZH), '注释里不重复整句抬头：' + out.text)
  })
})
