/**
 * tests/issue-239-queue-transient-write.test.mjs —— #239 队列整写的瞬时落盘错要重试。
 *
 * 真机现场（2026-10-20 web profile）：卡路里首次安装时队列账本整写撞了一次 `EPERM`
 * （Windows 上另一个进程短暂持有句柄），`update.store.fail {op:"write-queue", reason:"eperm"}`；
 * 这次失败随后被换算成「上次安装异常中断」，用户看到 recovery-required。
 *
 * 契约（注入写入/改名实现，只测外部行为）：
 * 1. 写临时文件瞬时 EPERM：重试后整写成功（不把瞬时占用升格成恢复态）；
 * 2. 改名瞬时 EPERM：重试后整写成功；
 * 3. 持续 EPERM：重试耗尽后按 `queue-unavailable` 失败，并落一条 `update.store.fail`（op=write-queue）；
 * 4. 非瞬时错（如 ENOSPC）：不重试、立即失败。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyQueueState, enqueueInQueue } from '../dist/core/queue/model.js'
import { createUpdateQueuePorts } from '../dist/core/queue/ports.js'

const tmpRoots = []

function makeScope() {
  const home = mkdtempSync(join(tmpdir(), 'dpu-239-home-'))
  tmpRoots.push(home)
  return { home, profile: join(home, 'profiles', 'desktop') }
}

function collectLogs() {
  const fires = []
  return {
    fires,
    logFor: () => (level, event, fields) => fires.push({ level, event, fields }),
  }
}

function queuedState(pluginId = 'p-a', requestId = 'req-1') {
  return enqueueInQueue(emptyQueueState(), { pluginId, requestId, enqueuedAt: 7 }).state
}

function fsError(code) {
  return Object.assign(new Error(code), { code })
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('#239 队列整写：瞬时落盘错重试', () => {
  it('写临时文件瞬时 EPERM：重试后成功，队列真的落盘', async () => {
    const { home, profile } = makeScope()
    const { fires, logFor } = collectLogs()
    let writes = 0
    const ports = createUpdateQueuePorts(home, profile, {
      logFor,
      nowImpl: () => 1000,
      writeFileImpl: async (filename, data, options) => {
        writes += 1
        if (writes <= 2) throw fsError('EPERM')
        await writeFile(filename, data, options)
      },
    })
    await ports.writeQueue(queuedState())
    const read = await ports.readQueue()
    assert.equal(read.waiting[0]?.pluginId, 'p-a', '重试后账本必须真写进去')
    assert.equal(writes, 3, '瞬时错应重试到成功（2 次失败 + 1 次成功）')
    assert.equal(
      fires.some((row) => row.event === 'update.store.fail'),
      false,
      '瞬时错误重试成功后不许留下失败记录',
    )
  })

  it('改名瞬时 EPERM：重试后成功', async () => {
    const { home, profile } = makeScope()
    const { logFor } = collectLogs()
    let renames = 0
    const ports = createUpdateQueuePorts(home, profile, {
      logFor,
      nowImpl: () => 1000,
      renameImpl: async (from, to) => {
        renames += 1
        if (renames <= 1) throw fsError('EPERM')
        await rename(from, to)
      },
    })
    await ports.writeQueue(queuedState())
    const read = await ports.readQueue()
    assert.equal(read.waiting[0]?.pluginId, 'p-a')
    assert.equal(renames, 2)
  })

  it('持续 EPERM：重试耗尽后按 queue-unavailable 失败，并落一条 write-queue 失败记录', async () => {
    const { home, profile } = makeScope()
    const { fires, logFor } = collectLogs()
    let writes = 0
    const ports = createUpdateQueuePorts(home, profile, {
      logFor,
      nowImpl: () => 1000,
      writeFileImpl: async () => {
        writes += 1
        throw fsError('EPERM')
      },
    })
    await assert.rejects(ports.writeQueue(queuedState()), (error) => {
      assert.equal(error?.code, 'queue-unavailable')
      return true
    })
    assert.equal(writes, 3, '受限重试：最多 3 次')
    const fail = fires.find((row) => row.event === 'update.store.fail')
    assert.ok(fail, '持续失败要落 update.store.fail')
    assert.equal(fail.fields.op, 'write-queue')
    assert.equal(fail.fields.reason, 'eperm')
  })

  it('非瞬时错（ENOSPC）：不重试，立即失败', async () => {
    const { home, profile } = makeScope()
    const { logFor } = collectLogs()
    let writes = 0
    const ports = createUpdateQueuePorts(home, profile, {
      logFor,
      nowImpl: () => 1000,
      writeFileImpl: async () => {
        writes += 1
        throw fsError('ENOSPC')
      },
    })
    await assert.rejects(ports.writeQueue(queuedState()), (error) => {
      assert.equal(error?.code, 'queue-unavailable')
      return true
    })
    assert.equal(writes, 1, '非瞬时错不重试')
  })
})


