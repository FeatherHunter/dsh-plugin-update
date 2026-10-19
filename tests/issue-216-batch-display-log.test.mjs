/**
 * tests/issue-216-batch-display-log.test.mjs —— #216 批量面板三处显示缺陷 + 批次日志对齐。
 *
 * 真机三处（2026-10-19 07:54 那批）：
 *   1. 作息管家「0.0.0 → 0.3.72 已是最新，无需操作」：集成方注入占位运行版 0.0.0，
 *      且磁盘版==最新版、任务已是 restart-required，结论被误判成「已是最新」。
 *   2. 「加入队列」与「正在安装」按钮在档案卷主题里文字不可见；「正在安装」没有动效。
 *   3. 日志缺口：一批续跑时总账 durationMs 报了 7 小时（建会话至今）、没有「这次推进开始」行、
 *      check-expired 自动重查没有行、check.done 分不出「已装好等重启」、客户端事件被丢只剩 reason。
 *
 * 本文件钉住修复后的可观察行为（只走 dist 公共入口、假传输与临时目录，不碰真机）：
 *   A. 批量收尾：磁盘已是目标版、任务/环境待重启 → 账本 `done` + `restartRequired`，不报失败；
 *      同一轮里 check.done 带 pendingRestart / jobState，日志读得出“还差一次重启”。
 *   B. 显示：版本列不吃占位运行版号；正在安装按钮带 `data-busy` / `aria-busy` 与动效样式；
 *      档案卷主题的透明底只给次级按钮（主按钮/在装按钮保留实底）。
 *   C. 日志：一批一条 `update.batch.run.start`（trigger/resumed/total/pending/sessionHash）；
 *      总账 durationMs 是本次推进活跃时长、sessionAgeMs 单独如实给、resumed 有值；
 *      批量里首次提交 check-expired（ADR-0004 §3 A 案设计内）留一条 `update.install.retry`；
 *      客户端丢弃上浮行带被丢事件名（`update.log.degraded.event`）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { hash8 } from '../dist/shared/hash.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import {
  UPDATE_BATCH_PANEL_ARCHIVE_CSS,
  UPDATE_BATCH_PANEL_CSS,
  batchRowVersionParts,
  renderBatchPanelHTML,
} from '../dist/panel-batch.js'
import { UPDATE_PANEL_ARCHIVE_CSS } from '../dist/panel.js'
import { createClientLogChannel } from '../dist/log/client-queue.js'
import { primeUpdateEventTable } from '../dist/log/manifest.js'
import {
  SILENT,
  bind,
  collector,
  fakeTransport,
  mkScope,
  mkTarget,
  phaseOf,
  rowsOf,
  unbindAll,
} from './helpers/batch-log-harness.mjs'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
  primeUpdateEventTable()
})

afterEach(() => {
  unbindAll()
})

/**
 * 真路径假读侧（#216 自用版）：在 batch-log-harness 的 installOverrides 基础上，
 * 让 runInstall 真把磁盘版写成目标版——装完 running 还停在旧版，核心如实给 restart-required。
 * 每家一个安装指纹（凭证槽按指纹寻址，别串家）。
 */
function realSide(dir, targetName) {
  const registry = 'https://registry.npmjs.org/'
  let installed = '1.0.0'
  let job = null
  let clock = 1000000
  return {
    runningVersion: '1.0.0',
    profileDir: dir,
    homeDir: dir,
    profileName: 'web',
    environmentKind: 'cli',
    nodeVersion: '22.0.0',
    targetPackageName: targetName,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: targetName,
          version: '2.0.0',
          engines: { node: '>=22' },
          dist: {
            tarball: registry + targetName + '/-/' + targetName + '-2.0.0.tgz',
            integrity: 'sha512-' + 'A'.repeat(86) + '==',
          },
        }),
    }),
    now: () => (clock += 10),
    randomId: (() => {
      let n = 0
      return () => 'id-' + (n += 1)
    })(),
    readInstalled: async () => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: dir,
      profileDir: dir,
      installedVersion: installed,
      packageValid: true,
      sourceInstall: false,
      blockedReason: null,
      installationKey: 'key-' + targetName,
      eligible: true,
    }),
    readJob: async () => job,
    writeJob: async (value) => {
      job = value
    },
    tryAcquireLock: async () => true,
    releaseLock: async () => {},
    backupJob: async () => {},
    runInstall: async (args) => {
      installed = (args && typeof args.version === 'string' && args.version) || '2.0.0'
    },
  }
}

/** 一份 restart-required 任务的假读侧：磁盘已是目标版、运行版还停在旧版。 */
function pendingRestartSide(dir, targetName) {
  const side = realSide(dir, targetName)
  side.readInstalled = async () => ({
    profileName: 'web',
    environmentKind: 'cli',
    homeDir: dir,
    profileDir: dir,
    installedVersion: '2.0.0',
    packageValid: true,
    sourceInstall: false,
    blockedReason: null,
    installationKey: 'key-' + targetName,
    eligible: true,
  })
  side.readJob = async () => ({
    id: 'job-restart-216',
    state: 'restart-required',
    targetVersion: '2.0.0',
    message: null,
    requestId: 'req-restart-216',
  })
  return side
}

describe('#216 批量收尾：已装好只等重启不是「已是最新」', () => {
  it('磁盘==目标版 + 任务 restart-required → 账本 done + restartRequired，且 check.done 读得出待重启', async () => {
    const { dir, scope } = await mkScope()
    const host = createMultiHostUpdate(
      { scope, installPollMs: 5, readerOverrides: pendingRestartSide(dir, 'pkg-a') },
      { prefix: 'life', targets: [mkTarget('a')], selfKey: 'a' },
    )
    const owner = collector()
    bind('plugin-a', owner.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const entry = reply.session.entries.find((item) => item.key === 'a')
    assert.equal(entry.phase, 'done', '装好等重启是 done，不再判成 current')
    assert.equal(entry.targetVersion, '2.0.0')
    assert.equal(entry.restartRequired, true)
    assert.equal(entry.error, null)
    assert.equal(host.lastRun.stoppedBecause, 'finished')

    const checks = rowsOf(owner, 'update.check.done')
    assert.ok(checks.length >= 1, '检查成功落一条')
    assert.equal(checks[0].fields.pendingRestart, true, 'check.done 要能读出「还差一次重启」')
    assert.equal(checks[0].fields.jobState, 'restart-required')
    assert.equal(rowsOf(owner, 'update.batch.entry.fail').length, 0, '没有失败行')
    host.dispose()
  })
})

describe('#216 显示：占位版号不进版本列，正在安装可见且动起来', () => {
  it('快照运行版是占位 0.0.0：版本列退回磁盘版；两者皆占位即不画假号', () => {
    const row = {
      key: 'schedule',
      title: '作息管家',
      phase: 'done',
      targetVersion: '0.3.72',
      restartRequired: true,
      error: null,
      snapshot: {
        runningVersion: '0.0.0',
        installed: true,
        installedVersion: '0.3.72',
        latestVersion: '0.3.72',
        canInstall: false,
        blockedReason: 'pending-restart',
        job: { state: 'restart-required' },
      },
      pluginId: 'life-schedule',
      profileName: 'desktop',
      hostKind: 'desktop-manager',
    }
    const parts = batchRowVersionParts(row, null)
    assert.equal(parts.current, '0.3.72', '占位运行版号不作当前版，退回磁盘版')
    assert.equal(parts.hasUpdate, false)
    assert.ok(!JSON.stringify(parts).includes('0.0.0'), '版本列不许出现 0.0.0')

    const unknown = { ...row, snapshot: { runningVersion: '0.0.0', installed: true, installedVersion: null } }
    assert.equal(batchRowVersionParts(unknown, null).current, null, '两格皆占位/缺失就 null，不猜')
  })

  it('整面板：正在安装按钮带 data-busy/aria-busy；版本列不出现 0.0.0', () => {
    const rows = [
      {
        key: 'schedule',
        title: '作息管家',
        phase: 'done',
        targetVersion: '0.3.72',
        restartRequired: true,
        error: null,
        snapshot: { runningVersion: '0.0.0', installed: true, installedVersion: '0.3.72', latestVersion: '0.3.72' },
        pluginId: 'life-schedule',
        hostKind: 'desktop-manager',
      },
      {
        key: 'chef',
        title: '私家大厨',
        phase: 'installing',
        targetVersion: '0.3.72',
        restartRequired: false,
        error: null,
        snapshot: { installed: false, installedVersion: null, latestVersion: '0.3.72', runningVersion: '0.0.0' },
        pluginId: 'life-chef',
        hostKind: 'desktop-manager',
      },
    ]
    const session = {
      version: 1,
      id: 'batch-216-display',
      selfKey: 'life-pack',
      stopOnFailure: false,
      order: ['schedule', 'chef'],
      entries: [
        { key: 'schedule', phase: 'done', requestId: 'batch:1:schedule', targetVersion: '0.3.72', restartRequired: true, error: null, updatedAt: 1 },
        { key: 'chef', phase: 'installing', requestId: 'batch:1:chef', targetVersion: '0.3.72', restartRequired: false, error: null, updatedAt: 1 },
      ],
      createdAt: 1,
      updatedAt: 2,
    }
    const html = renderBatchPanelHTML({ rows, session, titles: {}, theme: 'archive' })
    assert.ok(html.includes('data-busy="1"'), '在装按钮带 data-busy')
    assert.ok(html.includes('aria-busy="true"'), '在装按钮带 aria-busy')
    assert.ok(!html.includes('0.0.0'), '面板版本列不出现占位版号')
  })

  it('样式：在装按钮有旋转/呼吸动效；档案卷主题的透明底只给次级按钮', () => {
    const css = String(UPDATE_BATCH_PANEL_CSS)
    assert.ok(css.includes('@keyframes dsh-upd-busy-spin'), '缺旋转动效')
    assert.ok(css.includes('@keyframes dsh-upd-busy-pulse'), '缺呼吸动效')
    assert.ok(css.includes('.dsh-upd-busy-btn:disabled'), '在装按钮要有独立可读配色')
    const archive = String(UPDATE_BATCH_PANEL_ARCHIVE_CSS)
    assert.ok(
      archive.includes('.dsh-upd-brow-actions button:not([data-primary="1"]):not([data-busy="1"])'),
      '档案卷透明底必须放过主按钮与在装按钮（否则文字看不见）',
    )
    assert.ok(archive.includes(':not([data-busy="1"])'), '详情/更多按钮的透明底同样不碰在装按钮')
    assert.ok(
      String(UPDATE_PANEL_ARCHIVE_CSS).includes('--dsh-update-button-bg:#fbf6ec'),
      '档案卷主题补齐按钮底色 token（旧版只有深色媒体查询里定义）',
    )
  })
})

describe('#216 日志：一批有开始行、总账分开活跃时长与会话年龄', () => {
  it('run.start 一条（trigger/resumed/total/pending/sessionHash），总账三格如实', async () => {
    const { scope } = await mkScope()
    const clock = { at: 1000 }
    const host = createMultiHostUpdate(
      {
        scope,
        logCtx: SILENT,
        now: () => clock.at,
        transport: fakeTransport(
          {
            a: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'done', restartRequired: false } },
            self: { check: { kind: 'current' } },
          },
          () => {
            clock.at += 10
          },
        ),
      },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const owner = collector()
    bind('plugin-self', owner.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)

    const starts = rowsOf(owner, 'update.batch.run.start')
    assert.equal(starts.length, 1, '一次真推进一条开始行')
    assert.deepEqual(Object.keys(starts[0].fields).sort(), ['pending', 'resumed', 'sessionHash', 'total', 'trigger'])
    assert.equal(starts[0].fields.trigger, 'entry', '用户点全部更新')
    assert.equal(starts[0].fields.resumed, false, '新开一批不是续跑')
    assert.equal(starts[0].fields.total, 2)
    assert.equal(starts[0].fields.pending, 2, '推进开始时两家都还没结论')
    assert.equal(starts[0].fields.sessionHash, hash8(reply.session.id))

    const summary = rowsOf(owner, 'update.batch.summary')
    assert.equal(summary.length, 1)
    const fields = summary[0].fields
    assert.deepEqual(
      Object.keys(fields).sort(),
      ['durationMs', 'failed', 'ok', 'resumed', 'sessionAgeMs', 'sessionHash', 'skipped', 'stoppedBecause', 'total'],
      '总账九格：新增 resumed / sessionAgeMs（#216）',
    )
    assert.equal(fields.durationMs, 30, '本次推进活跃时长：3 次传输 ×10ms')
    assert.equal(fields.sessionAgeMs, 30, '会话年龄同样从建会话量到收尾')
    assert.equal(fields.resumed, false)

    // 已收尾的会话再点「续跑」：没有真推进，不发开始行。
    await host.handlers['life.batchResume']({})
    assert.equal(rowsOf(owner, 'update.batch.run.start').length, 1)
    host.dispose()
  })
})

describe('#216 日志：批量里 check-expired 当场重查重提留一行', () => {
  it('两家以上批量首批提交凭证过期 → update.install.retry 如实记录，随后正常装完', async () => {
    const { dir, scope } = await mkScope()
    const sideOf = (spec) => {
      const side = realSide(dir, spec.packageName)
      if (spec.key !== 'self') return side
      // 测试确定性：读取器单槽「最后建的那家留下凭证」是既有行为，但两家检查谁先完成受机器负载影响。
      // 让 self 的检查拖后完成 → 安装 a 时其凭证必然已被挤掉，check-expired 重查重提是必然而不是撞时序。
      return {
        ...side,
        fetchImpl: async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return side.fetchImpl(...args)
        },
      }
    }
    const host = createMultiHostUpdate(
      { scope, installPollMs: 5, readerOverridesFor: sideOf },
      { prefix: 'life', targets: [mkTarget('a'), mkTarget('self')], selfKey: 'self' },
    )
    const a = collector()
    const self = collector()
    bind('plugin-a', a.sink)
    bind('plugin-self', self.sink)

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done', '重提之后正常装完')
    assert.equal(phaseOf(reply.session, 'self'), 'done')

    // 读取器单槽最后停在哪一家受并发调度影响（哪家最后创建谁留下凭证），但「至少一家的凭证会被挤掉」
    // 是确定的：装完第一家后读取器换成第二家，第二家的旧凭证必然过期。两家的行都收，避免撞时序。
    const retried = [...rowsOf(a, 'update.install.retry'), ...rowsOf(self, 'update.install.retry')]
    assert.ok(retried.length >= 1, '凭证过期后自动重查重提要留一行（不是静默）')
    const fields = retried[0].fields
    assert.deepEqual(Object.keys(fields).sort(), ['attempt', 'reason', 'requestHash'])
    assert.equal(fields.reason, 'check-expired')
    assert.equal(fields.attempt, 2, '第二次提交')
    assert.match(fields.requestHash, /^[0-9a-f]{8}$/, '请求编号只落指纹')
    // 设计内动作不是故障：真正的失败行不该有。
    assert.equal(rowsOf(a, 'update.batch.entry.fail').length + rowsOf(self, 'update.batch.entry.fail').length, 0)
    host.dispose()
  })
})

describe('#216 日志：客户端丢弃上浮行带被丢事件名', () => {
  it('缓冲挤掉时 update.log.degraded.event 记录第一件被丢的事（仍只上浮一条）', async () => {
    const calls = []
    const ch = createClientLogChannel({
      call: async (name, args) => {
        calls.push({ name, args })
        return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
      },
      phoneName: 'life.logAppend',
      timer: null,
      visibility: null,
      batchSize: 1000,
      maxQueue: 1,
    })
    ch.emit('info', 'update.panel.mount', { mode: 'panel' })
    ch.emit('info', 'update.panel.action', { action: 'install' })
    await ch.flush()
    // 上浮行是「本周期末尾塞进缓冲」的：同一冲刷周期里再交一次才送得出去。
    await ch.flush()
    const rows = calls.flatMap((item) => (Array.isArray(item.args?.rows) ? item.args.rows : []))
    const degraded = rows.filter((row) => row.event === 'update.log.degraded')
    assert.equal(degraded.length, 1, '多出来的行只上浮一条降级')
    assert.equal(degraded[0].fields.reason, 'client-drop-overflow')
    assert.equal(degraded[0].fields.event, 'update.panel.mount', '告诉读日志的人第一件被丢的是什么事')
  })
})
