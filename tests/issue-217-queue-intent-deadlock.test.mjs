/**
 * #217：队列里的「僵尸等待位」把后续安装全挡成 update-busy。
 *
 * 真机 2026-10-19 08:47（0.18.27 + life-pack 0.3.72）：
 *   宿主重启后自动续跑上一轮未收尾批次，把 life-bill / life-calorie 两条 waiting 意向写进
 *   共享队列后又停下（队首那条对应任务其实已经结束、owner 为空）；公平门于是让之后每次
 *   「全部更新」都在几毫秒内被判 `update-busy` 弹回，面板上看起来就是「点了没反应」，
 *   要等 10 分钟 TTL 才自愈——用户原话「我们不应该被这种BUG所阻塞」。
 *
 * 修法两处（都在宿主侧，客户端不用重打包）：
 *   1) src/queue.ts：owner 为空时，等待位超过 30 秒即视为僵尸（没人在装，留着只会挡路）；
 *      有人在装时仍按 10 分钟 TTL 等，别误伤正常排队。
 *   2) src/host.ts / src/host-batch.ts：公平门拒绝前撤掉自己刚占的位；批次一停（收尾/续跑停/
 *      取消/drain 一轮）就撤掉本批次自己的 waiting 意向，不把别人挡到 TTL。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { QUEUE_INTENT_STALE_MS, QUEUE_INTENT_TTL_MS, pruneExpiredIntents } from '../dist/core/queue/model.js'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import {
  SILENT,
  installOverrides,
  mkScope,
  mkTarget,
  unbindAll,
} from './helpers/batch-log-harness.mjs'

test.afterEach(() => {
  unbindAll()
})

const NOW = 1_000_000

test('queue：owner 为空时超 30 秒的等待位算僵尸；有人在装时仍按 10 分钟 TTL 保留', () => {
  const build = (owner) => ({
    version: 1,
    owner,
    waiting: [
      {
        pluginId: 'life-bill',
        requestId: 'batch-x-bill-1',
        targetVersion: null,
        enqueuedAt: NOW - QUEUE_INTENT_STALE_MS - 1,
      },
      {
        pluginId: 'life-calorie',
        requestId: 'batch-x-cal-1',
        targetVersion: null,
        enqueuedAt: NOW - 5_000,
      },
    ],
  })
  // owner 为空 = 没人在装：旧的队首（30 秒前）清掉，新的（5 秒前）留着。
  assert.deepEqual(
    pruneExpiredIntents(build(null), NOW).waiting.map((one) => one.pluginId),
    ['life-calorie'],
  )
  // owner 非空 = 有人正装着：等待中的意向按 10 分钟 TTL 保留，不能误伤。
  const owner = { pluginId: 'life-memo', jobId: 'job-1', requestId: null, targetVersion: null, startedAt: NOW - 60_000 }
  assert.deepEqual(
    pruneExpiredIntents(build(owner), NOW).waiting.map((one) => one.pluginId),
    ['life-bill', 'life-calorie'],
  )
  assert.ok(QUEUE_INTENT_STALE_MS < QUEUE_INTENT_TTL_MS)
})

test('host：查新读队列时就把僵尸意向落盘清掉，后续安装不再被它挡成 update-busy', async () => {
  __resetSharedUpdateReaderForTests()
  const { dir } = await mkScope('issue-217-host-')
  let raw = {
    version: 1,
    owner: null,
    waiting: [
      // 僵尸：owner 为空、5 分钟前（远超 30 秒僵尸线，但还没到 10 分钟 TTL）
      {
        pluginId: 'life-bill',
        requestId: 'batch-x-bill-1',
        targetVersion: null,
        enqueuedAt: NOW - 5 * 60_000,
      },
      // 年轻：有人刚点了一下（5 秒前），留着。
      {
        pluginId: 'life-calorie',
        requestId: 'batch-x-cal-1',
        targetVersion: null,
        enqueuedAt: NOW - 5_000,
      },
    ],
  }
  // 假钟与种子时间同一坐标系：installOverrides 的 now 从 1_000_000 起、每次 +10。
  // 显式给 readQueue/writeQueue 走内存队列：这条路径与真实落盘队列过的是同一个 prune 口。
  const overrides = {
    ...installOverrides(dir, 'pkg-a', async () => ({ version: '2.0.0' })),
    readQueue: () => raw,
    writeQueue: (next) => {
      raw = next
    },
  }
  const host = createHostUpdate(
    { logCtx: SILENT, readerOverrides: overrides },
    { pluginId: 'issue-217-host', prefix: 'i217', targetPackageName: 'pkg-a' },
  )
  const reply = await host.handlers['i217.updateCheck']({ includeQueue: true, showOthers: true, includeEnv: true, trigger: 'panel' })
  assert.equal(reply.ok, true)
  // 读队列的清理要真写回（否则下一次读又把它捡回来）：僵尸没了，年轻的还在。
  assert.deepEqual(
    raw.waiting.map((one) => one.pluginId),
    ['life-calorie'],
  )
  const visible = (reply.queue && reply.queue.waiting ? reply.queue.waiting : []).map((one) => one.pluginId)
  assert.deepEqual(visible, ['life-calorie'])
})

test('batch：再次开跑前先扫掉上一轮留下的自家排队占位，别家意向一条不动', async () => {
  const { scope } = await mkScope('issue-217-batch-')
  let state = {
    version: 1,
    owner: null,
    waiting: [
      // 上一轮停下时留下的自家占位（requestId 以 batch- 开头、pluginId 属于本批次目标）。
      // 真机里它对应的任务已经结束，不扫掉就会在下一轮开跑时把公平门挡成 update-busy。
      {
        pluginId: 'plugin-a',
        requestId: 'batch-stale-a-1234abcd',
        targetVersion: null,
        enqueuedAt: NOW,
      },
      // 别家的（不属于本批次目标）：不许替别人清。
      {
        pluginId: 'some-other-plugin',
        requestId: 'manual-request',
        targetVersion: null,
        enqueuedAt: NOW,
      },
    ],
  }
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => ({ kind: 'done', restartRequired: false }),
  }
  const host = createMultiHostUpdate(
    {
      scope,
      transport,
      now: () => NOW,
      installPollMs: 5,
      readerOverrides: {
        readQueue: () => state,
        writeQueue: (next) => {
          state = next
        },
      },
    },
    { prefix: 'q217', targets: [mkTarget('a')], selfKey: 'a' },
  )
  const reply = await host.handlers['q217.batchInstall']({})
  assert.equal(reply.ok, true)
  assert.equal(reply.session.entries.find((one) => one.key === 'a').phase, 'done')
  // 自家遗留占位被扫掉；别家的留在原地。
  assert.deepEqual(
    state.waiting.map((one) => one.pluginId),
    ['some-other-plugin'],
  )
})