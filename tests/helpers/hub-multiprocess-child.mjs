/**
 * tests/helpers/hub-multiprocess-child.mjs —— #276「真·多进程单写者」测试的子进程夹具。
 *
 * 由 tests/hub-multiprocess.test.mjs 起成独立的 node 进程（不是同进程假宿主），两个子进程共享
 * 同一份临时 homeDir/profileDir，各自用生产装配 createMultiHostUpdate(hub:true) 提交同一批次，
 * 真实经过 registry / boundary / plan-store / lease-store 的磁盘互斥与 batch.json 账本。
 *
 * 参数走环境变量（父进程只通过 stdout 的 MP: 单行 JSON 事件观察）：
 *   MP_ROLE=driver|contender   driver 拿到驾驶位真装 3 秒（> 缩短后的陈旧窗口）；contender 只该被挡在门外
 *   MP_HOME / MP_PROFILE       共享的临时使用范围
 *   MP_INSTALL_SLEEP_MS        安装步挂多久（要大于 MP_STALE_MS，否则测不到「长安装步心跳」）
 *   MP_STALE_MS / MP_HEARTBEAT_MS  注入的租约陈旧窗口/心跳间隔（生产缺省 20s/5s 只适合真机）
 *   MP_RETRY_MS                中枢退避重试间隔
 *   MP_POLL_MS                 采样盘上租约的间隔
 *
 * 只依赖 Node 内置与 dist/ 公共入口，不 import src/。
 */
import { createMultiHostUpdate } from '../../dist/host-batch.js'
import { hubPathsForUpdate } from '../../dist/host/hub/plan-store.js'
import { readHubLease } from '../../dist/host/hub/lease-store.js'
import { createUpdateQueuePorts } from '../../dist/core/queue/ports.js'
import { mkTarget, phaseOf } from './batch-log-harness.mjs'

const role = process.env.MP_ROLE
const homeDir = process.env.MP_HOME
const profileDir = process.env.MP_PROFILE
const installSleepMs = Number(process.env.MP_INSTALL_SLEEP_MS ?? 3000)
const leaseStaleMs = Number(process.env.MP_STALE_MS ?? 2500)
const heartbeatMs = Number(process.env.MP_HEARTBEAT_MS ?? 1000)
const retryMs = Number(process.env.MP_RETRY_MS ?? 200)
const pollMs = Number(process.env.MP_POLL_MS ?? 120)

const paths = hubPathsForUpdate(homeDir, profileDir)
// 真安装还要占 queue 的全局锁（ADR-0003 §4：谁写盘装包）。夹具里也照真路径拿一次真实 global.lock，
// 证明「中枢租约 + 既有全局锁」两层在真进程里能同时工作，而不是把锁替换成替身。
const queuePorts = createUpdateQueuePorts(homeDir, profileDir)
const queueLockId = 'mp-' + String(role ?? 'x') + '-' + process.pid
const samples = []
const startedAt = Date.now()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** stdout 只发 MP: 开头的单行 JSON；等写完成再继续，避免 process.exit 截掉尾巴。 */
const writeLine = (line) => new Promise((resolve) => process.stdout.write(line, resolve))
const emit = async (event, data = {}) => {
  await writeLine('MP:' + JSON.stringify({ event, at: Date.now() - startedAt, ...data }) + '\n')
}

/** 采一份盘上租约的原始事实（谁在驾驶、第几代、心跳停在什么时候）。 */
async function sampleLease() {
  const at = Date.now()
  try {
    const lease = await readHubLease(paths)
    samples.push({
      at,
      lease: lease
        ? { driverId: lease.driverId, generation: lease.generation, heartbeatAt: lease.heartbeatAt, pid: lease.pid }
        : null,
    })
  } catch (error) {
    samples.push({ at, readError: String(error) })
  }
}

let installCalls = 0
const installs = []
const transport = {
  check: async () => ({ kind: 'update', version: '2.0.0' }),
  install: async (key) => {
    installCalls += 1
    installs.push(key)
    if (role === 'driver') {
      // 装 3 秒：比注入的陈旧窗口（2.5 秒）长，只有心跳真的在安装步里续活，别的驾驶位才不该接管。
      // 同时按真安装路径占住 queue 的 global.lock（真实文件，不是替身），装完再放。
      const globalLock = queuePorts.paths ? await queuePorts.tryAcquireGlobalLock(queueLockId, 'life', { timeoutMs: 5_000 }) : false
      await emit('install-start', { globalLock })
      await sleep(installSleepMs)
      await emit('install-end')
      if (globalLock) await queuePorts.releaseGlobalLock(queueLockId)
      return { kind: 'done', restartRequired: false }
    }
    // 竞争进程本不该拿到驾驶位：真被调用就留证据，父进程断言这里是 0 次。
    await emit('contender-install', { key })
    return { kind: 'done', restartRequired: false }
  },
}

const host = createMultiHostUpdate(
  {
    scope: { homeDir, profileDir },
    transport,
    hubLeaseStaleMs: leaseStaleMs,
    hubHeartbeatMs: heartbeatMs,
    hubRetryMs: retryMs,
  },
  { hub: true, prefix: 'life', targets: [mkTarget('a')] },
)

let reply = null
let phoneError = null
let phoneDurationMs = null
const poller = setInterval(() => {
  void sampleLease()
}, pollMs)
try {
  await emit('ready')
  const phoneStartedAt = Date.now()
  reply = await host.handlers['life.batchInstall']({})
  phoneDurationMs = Date.now() - phoneStartedAt
} catch (error) {
  phoneError = String(error?.stack ?? error)
} finally {
  clearInterval(poller)
  // 让在途的采样读落定，再补最后一份：样本靠墙钟排序时不会被迟到的那次读打乱。
  await sleep(pollMs + 60)
  await sampleLease()
}
await emit('result', {
  role,
  ok: reply?.ok ?? null,
  sessionId: reply?.session?.id ?? null,
  phaseA: reply?.session ? phaseOf(reply.session, 'a') : null,
  entryA: reply?.session?.entries?.find((entry) => entry.key === 'a') ?? null,
  phoneError,
  phoneDurationMs,
  installCalls,
  installs,
  samples,
})
host.dispose()
process.exit(0)
