/**
 * tests/hub-multiprocess.test.mjs —— #276 P0：真·多进程单写者（两个 node 子进程抢同一份账本）。
 *
 * 与 hub-single-writer.test.mjs（同进程、假时钟、手动写租约）互补：这里起两个独立 node 进程，
 * 共享同一份临时 homeDir/profileDir，各自用生产装配 createMultiHostUpdate(hub:true) 提交同一批次：
 *   - 驾驶位进程的安装步挂 3 秒（> 注入的 2.5 秒租约陈旧窗口），只有心跳在安装步里真续活，
 *     竞争进程才不会把活人误判成假死、才不会换代接管；
 *   - 竞争进程在驾驶位已进安装步之后才起，它这次提交只能被挡在门外（诚实回 queued/现状），
 *     不许真装、不许把账本写成 failed。
 * 断言（对应 #276 验收）：
 *   (a) 单写者：整轮只装一次，且只发生在驾驶位进程；竞争进程 installCalls=0，代次不跳变；
 *   (b) 盘上 batch.json 与两个调用方的回值一致：装完是 done，没有被旧代次覆盖成 failed；
 *   (c) 两个调用方结果不矛盾：驾驶位 done，竞争进程不得到相反的 failed；
 *   (d) 长安装步期间租约心跳续活（heartbeatAt 前进）、不换代（driverId/generation 恒定）。
 *
 * 中枢路径的推进互斥原语是 lease.json；安装写盘的互斥仍是既有 queue.json + global.lock（ADR-0003 §4）——
 * 驾驶位在慢安装步里按真安装路径真实持有 global.lock（真实文件，不是替身），两层互斥在真进程里同时工作。
 * 本文件走完整生产装配：真实 registry/boundary/plan-store/lease-store + 真实 batch.json/global.lock 文件 + 真实定时器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { batchPathsForOwner } from '../dist/core/disk.js'
import { queuePathsForUpdate } from '../dist/core/queue/ports.js'
import { mkScope, phaseOf } from './helpers/batch-log-harness.mjs'

const CHILD_FILE = fileURLToPath(new URL('./helpers/hub-multiprocess-child.mjs', import.meta.url))
const INSTALL_SLEEP_MS = 3000
const STALE_MS = 2500
const HEARTBEAT_MS = 1000

/** 起一个子进程，按行收集 MP: 事件（半行/坏行忽略，不参与断言）。 */
function startChild(role, env) {
  const child = spawn(process.execPath, [CHILD_FILE], {
    cwd: process.cwd(),
    env: { ...process.env, MP_ROLE: role, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const events = []
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (!line.startsWith('MP:')) continue
      try {
        events.push(JSON.parse(line.slice(3)))
      } catch {
        // 子进程被强杀时可能留下半行：忽略。
      }
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stderr })))
  return { child, events, exited, stderr: () => stderr }
}

async function waitEvent(handle, event, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = handle.events.find((item) => item.event === event)
    if (found) return found
    if (Date.now() > deadline) {
      handle.child.kill()
      assert.fail(`等待超时：${label}（没看到 ${event}；子进程 stderr=${handle.stderr().slice(-1500)}）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function resultOf(handle, role) {
  const result = handle.events.find((item) => item.event === 'result')
  assert.ok(result, `${role} 子进程没回报结果（可能被杀；stderr=${handle.stderr().slice(-1500)}）`)
  return result
}

test('真实双进程：同一批次只有一个驾驶位写账本，长安装步心跳续活不换代，两个调用方的结果与盘上账本不矛盾', async () => {
  const { dir, scope } = await mkScope('hub-multiprocess-')
  const env = {
    MP_HOME: scope.homeDir,
    MP_PROFILE: scope.profileDir,
    MP_INSTALL_SLEEP_MS: String(INSTALL_SLEEP_MS),
    MP_STALE_MS: String(STALE_MS),
    MP_HEARTBEAT_MS: String(HEARTBEAT_MS),
  }
  const driver = startChild('driver', env)
  let contender = null
  try {
    // 等驾驶位进程真拿到租约、进安装步，再起竞争进程：竞争发生在一个活的驾驶位身上，不是空盘抢跑。
    const driverStart = await waitEvent(driver, 'install-start', 10000, '驾驶位进程进入安装步')
    // 慢安装步里同时持有 queue 的全局锁（真实文件）：两层互斥在真进程里同时工作。
    assert.equal(driverStart.globalLock, true, '驾驶位在慢安装步里真实持有 queue global.lock')
    const queuePaths = queuePathsForUpdate(scope.homeDir, scope.profileDir)
    const lockOnDisk = JSON.parse(await readFile(queuePaths.lock, 'utf8'))
    assert.equal(lockOnDisk.pluginId, 'life', 'global.lock 记着安装方（真实文件，不是替身）')
    assert.equal(lockOnDisk.pid, driver.child.pid, '持有 global.lock 的正是驾驶位子进程')
    contender = startChild('contender', env)
    const [driverExit, contenderExit] = await Promise.all([driver.exited, contender.exited])
    assert.equal(driverExit.code, 0, `驾驶位进程正常退出（stderr=${driverExit.stderr.slice(-1500)}）`)
    assert.equal(contenderExit.code, 0, `竞争进程正常退出（stderr=${contenderExit.stderr.slice(-1500)}）`)

    const driverResult = resultOf(driver, '驾驶位')
    const contenderResult = resultOf(contender, '竞争进程')
    assert.equal(driverResult.phoneError, null, '驾驶位电话不抛错')
    assert.equal(contenderResult.phoneError, null, '竞争进程电话不抛错（驾驶位占着不许外抛）')

    // (a) 单写者：装只发生一次，且只发生在驾驶位进程。
    assert.equal(driverResult.installCalls, 1, '驾驶位真装了一次')
    assert.equal(contenderResult.installCalls, 0, '竞争进程一次都没装（同一时刻只有一个驾驶位）')
    assert.equal(contender.events.some((item) => item.event === 'contender-install'), false, '竞争进程没有抢到驾驶位')

    // (c) 两个调用方看到的结果不矛盾：不出现「一个 done、一个 failed」。
    assert.equal(driverResult.ok, true)
    assert.equal(driverResult.phaseA, 'done', '驾驶位装完并收尾')
    assert.equal(contenderResult.ok, true, '竞争进程的提交有回值')
    assert.notEqual(contenderResult.phaseA, 'failed', '竞争进程不得看到相反的 failed')
    assert.equal(contenderResult.entryA?.error ?? null, null, '竞争进程的快照里没有被写成失败')

    // (d) 长安装步（3 秒 > 2.5 秒陈旧窗口）期间心跳续活、不换代、不被误接管。
    const driverLeases = driverResult.samples.filter((sample) => sample.lease).map((sample) => sample.lease)
    assert.ok(driverLeases.length >= 4, `驾驶位安装期间至少看到 4 份租约样本（实际 ${driverLeases.length}）`)
    const driverIds = new Set(driverLeases.map((lease) => lease.driverId))
    assert.equal(driverIds.size, 1, '安装期间驾驶位从头到尾是同一个 driverId（没换代）')
    assert.deepEqual(
      driverLeases.map((lease) => lease.generation),
      driverLeases.map(() => 1),
      '安装期间代次始终是 1（没被接管）',
    )
    const beats = driverLeases.map((lease) => lease.heartbeatAt)
    assert.ok(Math.max(...beats) > Math.min(...beats), '安装期间心跳被续活（不是一份停着不动的租约）')

    const contenderLeases = contenderResult.samples.filter((sample) => sample.lease).map((sample) => sample.lease)
    assert.ok(contenderLeases.length >= 1, '竞争进程等待时看到过驾驶位的租约（不是空盘）')
    assert.equal(
      contenderLeases.every((lease) => lease.driverId === [...driverIds][0]),
      true,
      '竞争进程看到的也是同一个驾驶位（没有接管出新 driverId）',
    )
    assert.equal(
      contenderLeases.every((lease) => lease.generation === 1),
      true,
      '竞争进程看到的是第 1 代（没有接管换代）',
    )

    // (b) 盘上账本与调用方回值一致：装完就是 done，旧代次没机会把它覆盖成 failed。
    const batchFile = batchPathsForOwner(scope.homeDir, scope.profileDir, 'life').batchFile
    const onDisk = JSON.parse(await readFile(batchFile, 'utf8'))
    assert.equal(onDisk.id, driverResult.sessionId, '盘上账本正是驾驶位那份会话')
    assert.equal(phaseOf(onDisk, 'a'), 'done', '盘上 a 是 done（没有被旧代次覆盖成 failed）')
    const diskEntryA = onDisk.entries.find((entry) => entry.key === 'a')
    assert.equal(diskEntryA.error ?? null, null, '盘上没有失败痕迹')
    assert.equal(diskEntryA.restartRequired, false, '装完不需要重启（假传输返回 done/restartRequired:false）')

    // 收尾后驾驶位把租约放掉：盘上不留下没人维持的旧租约。
    const finale = driverResult.samples
      .filter((sample) => 'lease' in sample)
      .sort((left, right) => left.at - right.at)
      .at(-1)
    assert.equal(finale?.lease ?? null, null, '驾驶位收手后租约已释放')
  } finally {
    contender?.child.kill()
    driver.child.kill()
    await rm(dir, { recursive: true, force: true })
  }
})
