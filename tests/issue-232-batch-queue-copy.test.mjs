/**
 * #231 / #232 渲染契约（真机 2026-10-19 17:52–17:53 desktop）：
 *
 * A. 批量进行中、尚未轮到的 ready 行：这些行已经在批次账本队列里，消费完上一家会自动装。
 *    行状态必须说「已在队列 · 会自动依次安装」，不画「加入队列」按钮，也不带「（上次未完成）」——
 *    否则用户会以为要手动逐个入队（#232）。
 * B. 打开面板首帧（自动检查还没结论）：旧批次账本的 done 行不得显示成「已安装完成/已是最新」，
 *    总账行也不得先报「N 个已是最新」——统一按「检查中」表达（#231）。
 * C. 会话已收尾时不再出现「继续上次未完成的更新（剩余 0 个）」类提示（#231/#232）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderBatchPanelHTML } from '../dist/panel-batch.js'

function makeRow(key, phase, options = {}) {
  const installedVersion = options.installedVersion ?? '0.3.73'
  return {
    key,
    title: key,
    phase,
    targetVersion: options.targetVersion ?? '0.3.74',
    restartRequired: options.restartRequired ?? false,
    error: options.error ?? null,
    snapshot: {
      runningVersion: installedVersion,
      installed: true,
      installedVersion,
      latestVersion: '0.3.74',
      canInstall: true,
      blockedReason: null,
      job: options.job ?? null,
      identity: 'update',
      registered: true,
    },
    manual: null,
    queue: null,
    profileName: 'desktop',
    hostKind: 'desktop-manager',
    pluginId: 'life-' + key,
  }
}

function makeSession(entries) {
  return {
    version: 1,
    id: 'batch-232',
    selfKey: 'life-pack',
    stopOnFailure: false,
    order: entries.map((entry) => entry.key),
    entries: entries.map((entry, index) => ({
      restartRequired: false,
      error: null,
      updatedAt: 2,
      requestId: 'req-' + entry.key,
      ...entry,
    })),
    createdAt: 1,
    updatedAt: 2,
  }
}

function render(rows, session, extra = {}) {
  return renderBatchPanelHTML({
    rows,
    session,
    titles: Object.fromEntries(rows.map((row) => [row.key, row.key])),
    lang: 'zh',
    ...extra,
  })
}

test('#232 批量进行中：未轮到的 ready 行说「已在队列」，不画「加入队列」也不带「上次未完成」', () => {
  const session = makeSession([
    { key: 'bill', phase: 'installing' },
    { key: 'calorie', phase: 'ready' },
    { key: 'home', phase: 'ready' },
  ])
  const rows = [
    makeRow('bill', 'installing', { job: { state: 'installing', targetVersion: '0.3.74', message: null, requestId: 'req-bill' } }),
    makeRow('calorie', 'ready'),
    makeRow('home', 'ready'),
  ]
  const html = render(rows, session)
  assert.ok(html.includes('已在队列'), '排队行应说已在队列')
  assert.ok(html.includes('会自动依次安装'), '排队行应说明会自动装')
  assert.ok(!html.includes('加入队列'), '批量进行中不该再出现「加入队列」按钮文案')
  assert.ok(!html.includes('（上次未完成）'), '本批预查 ready 行不该带「（上次未完成）」标记')
  assert.ok(html.includes('队列里还有'), '顶部提示应说明剩余在队列里，而不是「可选择加入队列」')
})

test('#232 批次暂停（无安装在进行）：ready 行恢复手动「安装此插件」，不谎称自动排队', () => {
  const session = makeSession([
    { key: 'calorie', phase: 'ready' },
    { key: 'home', phase: 'ready' },
  ])
  const rows = [makeRow('calorie', 'ready'), makeRow('home', 'ready')]
  const html = render(rows, session)
  assert.ok(html.includes('安装此插件'), '暂停时仍应给手动安装入口')
  assert.ok(!html.includes('已在队列'), '没有安装在进行时不该说自动依次安装')
})

test('#231 首帧旧账本结果过期：done 行按「检查中」渲染，总账不先报已是最新', () => {
  const session = makeSession([
    { key: 'bill', phase: 'done', targetVersion: '0.3.73' },
    { key: 'calorie', phase: 'done', targetVersion: '0.3.73' },
  ])
  const rows = [makeRow('bill', 'done', { targetVersion: '0.3.73' }), makeRow('calorie', 'done', { targetVersion: '0.3.73' })]

  const stale = render(rows, session, { staleResults: true })
  assert.ok(stale.includes('正在按最新版本重新检查'), '总账应说明正在按最新版本重新检查')
  assert.ok(stale.includes('正在查询版本信息'), '旧 done 行状态应显示检查中')
  assert.ok(!stale.includes('已安装完成，无需操作'), '旧账本 done 不许在首帧冒充结论')

  const fresh = render(rows, session, { staleResults: false })
  assert.ok(fresh.includes('已安装完成，无需操作'), '检查完成后仍按账本真实相位说话')
})

test('#231/#232 会话已收尾：不出现「继续上次未完成的更新」控制区', () => {
  const session = makeSession([
    { key: 'bill', phase: 'done', targetVersion: '0.3.73' },
    { key: 'calorie', phase: 'done', targetVersion: '0.3.73' },
  ])
  const rows = [makeRow('bill', 'done', { targetVersion: '0.3.73' }), makeRow('calorie', 'done', { targetVersion: '0.3.73' })]
  const html = render(rows, session)
  assert.ok(!html.includes('继续上次未完成的更新'), '会话终态不该再出现继续入口')
  assert.ok(!html.includes('剩余 0 个'), '不该出现剩余 0 个的提示')
})
