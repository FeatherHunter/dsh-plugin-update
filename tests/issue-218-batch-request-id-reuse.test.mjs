// #218：批量续跑复用旧 requestId、宿主按 requestId 幂等命中上一轮旧任务 —— 账本记 done 但没装。
//
// 真机现场（2026-10-19 09:24，life-pack 0.3.73 客户端 + updater 0.18.28）：
//   - 六个单品账本全 done/targetVersion 0.3.73，只有作息管家真装（exec 5348ms + verify）；
//   - 其余五个 state.json 仍是 completed/targetVersion 0.3.72，日志里 09:24 后没有
//     update.install.request / update.install.exec / update.install.verify，updateInstall 6-8ms 就回 ok；
//   - 磁盘 node_modules 里五个仍 0.3.72；面板行却显示「已安装完成，无需操作」。
//
// 两处修法：
//   1) defaultInstall 认出「同一 requestId 的旧任务」回包（completed 别的版本 / failed / interrupted），
//      换一次尝试编号重提，并记 update.install.retry{reason:'stale-request-id'}；
//   2) settleInstall 的 done 一律核对磁盘版本 === 目标版本，对不上不认成功。
//
// 本测试：纯函数矩阵 + 真磁盘/真 host 的端到端复现（旧 completed 任务同 requestId，新目标 2.0.0）。

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attemptRequestId, createMultiHostUpdate, phoneRequestIdOf, staleIdempotentHit } from '../dist/host-batch.js'
import { batchRequestId } from '../dist/core/batch/model.js'
import { pathsForUpdate } from '../dist/core/disk.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-218-plugin'
const PLUGIN_ID = 'plugin-218'
const PREFIX = 'i218'
const NOW = 1_000_000
const REGISTRY = 'https://registry.npmjs.org/'
const OLD_VERSION = '1.0.0'
const NEW_VERSION = '2.0.0'

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function writeText(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, value)
}

function makeScope() {
  const home = mkdtempSync(join(tmpdir(), 'issue-218-'))
  const profile = join(home, 'profiles', 'desktop')
  writeJson(join(profile, 'package.json'), { name: 'profile-218', private: true, dependencies: { [TARGET]: '^' + OLD_VERSION } })
  return { home, profile }
}

function plantTarget(profile, version) {
  const dir = join(profile, 'node_modules', TARGET)
  writeJson(join(profile, 'node_modules', TARGET, 'package.json'), {
    name: TARGET,
    version,
    main: 'index.js',
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './patch.js' } },
  })
  for (const file of ['index.js', 'client.js', 'patch.js']) writeText(join(dir, file), 'module.exports = {}\n')
  return dir
}

function registerTarget(profile, version) {
  const path = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [TARGET]: '^' + version }
  writeJson(path, manifest)
}

function installedVersionOf(profile) {
  try {
    return JSON.parse(readFileSync(join(profile, 'node_modules', TARGET, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

function fakeLatest(version) {
  return async (url) => {
    assert.equal(url, REGISTRY + encodeURIComponent(TARGET) + '/latest')
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({
          name: TARGET,
          version,
          engines: { node: '>=22' },
          dist: { tarball: REGISTRY + TARGET + '/-/' + TARGET + '-' + version + '.tgz', integrity: 'sha512-' + 'A'.repeat(86) + '==' },
        })
      },
    }
  }
}

function sessionIdOfNow() {
  return NOW.toString(36) + '-fixed'
}

/** 种一个「上一轮已经完成」的旧任务：requestId 正是这一轮会话将要用到的电话编号。 */
function seedCompletedJob(home, profile, version) {
  const paths = pathsForUpdate(home, PLUGIN_ID, profile)
  assert.ok(paths, '账本想落盘，但 pathsForUpdate 返回 null')
  writeJson(paths.state, {
    id: 'old-job-218',
    state: 'completed',
    targetVersion: version,
    message: null,
    requestId: phoneRequestIdOf(batchRequestId(sessionIdOfNow(), 'a')),
    previousVersion: null,
  })
  return paths
}

function readQueue(home, profile, prefix = PREFIX) {
  // 与 host.ts createUpdateQueuePorts 同落点：update-queue/<hash>/queue.json（shared 前缀目录由宿主算）
  const dir = join(home, 'update-queue')
  return dir
}

describe('#218 幂等命中识别（纯函数）', () => {
  it('旧任务 completed 了别的版本 → 视为陈旧幂等命中', () => {
    const job = { requestId: 'r1', state: 'completed', targetVersion: OLD_VERSION }
    assert.equal(staleIdempotentHit(job, 'r1', NEW_VERSION), true)
    assert.equal(staleIdempotentHit(job, 'r1', OLD_VERSION), false)
    assert.equal(staleIdempotentHit(job, 'other', NEW_VERSION), false)
  })

  it('同一编号的 failed / interrupted 旧任务 → 也要换号，否则永远重试不出去', () => {
    assert.equal(staleIdempotentHit({ requestId: 'r1', state: 'failed' }, 'r1', NEW_VERSION), true)
    assert.equal(staleIdempotentHit({ requestId: 'r1', state: 'interrupted' }, 'r1', NEW_VERSION), true)
    assert.equal(staleIdempotentHit({ requestId: 'r1', state: 'installing' }, 'r1', NEW_VERSION), false)
    assert.equal(staleIdempotentHit({ requestId: 'r1', state: 'restart-required' }, 'r1', NEW_VERSION), false)
    assert.equal(staleIdempotentHit(null, 'r1', NEW_VERSION), false)
  })

  it('尝试编号：形状是核心收的不透明编号、与旧号不同、nonce 不同则号不同', () => {
    const old = phoneRequestIdOf(batchRequestId('sess-1', 'a'))
    const a = attemptRequestId(old, '1000|job-1')
    const b = attemptRequestId(old, '1000|job-1')
    const c = attemptRequestId(old, '2000|job-2')
    assert.equal(a, b, '同一 nonce 必须稳定（崩溃续跑才能认出同一尝试）')
    assert.notEqual(a, c)
    assert.notEqual(a, old)
    assert.match(a, /^[A-Za-z0-9._~-]{1,200}$/)
  })
})

describe('#218 端到端：旧 completed 任务同 requestId，新目标 2.0.0 必须真装', () => {
  let home
  let profile
  let logs

  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
    const scope = makeScope()
    home = scope.home
    profile = scope.profile
    plantTarget(profile, OLD_VERSION)
    logs = []
  })

  after(() => {
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('换号重提 → 磁盘真到 2.0.0、账本才记 done；并落 stale-request-id 重试行', async () => {
    seedCompletedJob(home, profile, OLD_VERSION)

    const batch = createMultiHostUpdate(
      {
        scope: { homeDir: home, profileDir: profile },
        now: () => NOW,
        randomId: () => 'fixed',
        installPollMs: 5,
        logCtx: { fire: (level, event, fields) => logs.push({ level, event, fields }) },
        readerOverridesFor: () => ({
          runningVersion: OLD_VERSION,
          targetPackageDir: join(profile, 'node_modules', TARGET),
          profileDir: profile,
          profileName: 'desktop',
          homeDir: home,
          environmentKind: 'cli',
          nodeVersion: '22.0.0',
          targetPackageName: TARGET,
          fetchImpl: fakeLatest(NEW_VERSION),
          now: () => NOW,
          randomId: () => 'id-1',
          runInstall: async (args) => {
            const version = typeof args?.version === 'string' && args.version ? args.version : NEW_VERSION
            registerTarget(profile, version)
            plantTarget(profile, version)
          },
        }),
      },
      {
        prefix: PREFIX,
        targets: [{ key: 'a', title: 'A', packageName: TARGET, prefix: 'p-218', pluginId: PLUGIN_ID }],
        selfKey: 'a',
      },
    )

    const reply = await batch.handlers[PREFIX + '.batchInstall']({})
    assert.equal(reply.ok, true, JSON.stringify(reply))

    const entry = reply.session.entries.find((one) => one.key === 'a')
    assert.ok(entry, '账本里应有 a 这一行')
    assert.equal(entry.phase, 'done')
    assert.equal(entry.targetVersion, NEW_VERSION)
    assert.equal(entry.restartRequired, true, '磁盘已换新、运行版还是旧的 → 必须提示重启')
    assert.equal(entry.error, null)

    assert.equal(installedVersionOf(profile), NEW_VERSION, '账本说完成，磁盘就必须真的是 2.0.0')

    const retries = logs.filter((row) => row.event === 'update.install.retry' && row.fields?.reason === 'stale-request-id')
    assert.ok(retries.length >= 1, '必须留下换号重提说明行，读日志者才知道为什么重提')
    assert.equal(retries[0].fields.attempt, 2)
    assert.match(String(retries[0].fields.requestHash), /^[0-9a-f]{8}$/)

    const installRequests = logs.filter((row) => row.event === 'update.install.request')
    assert.ok(installRequests.length >= 1, '旧任务幂等命中不能算安装——真装必须重新发 update.install.request')
  })
})
