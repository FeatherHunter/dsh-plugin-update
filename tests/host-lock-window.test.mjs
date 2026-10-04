/**
 * tests/host-lock-window.test.mjs —— 锁陈旧判据的阈值单源（#26 照出来的分叉）。
 *
 * 只测外部行为：宿主把**安装时限**（installTimeoutMs）同时用作抢全局锁的陈旧判据，
 * 并且**显式注入的抢锁实现也拿到同一个值**——阈值只由一处决定。
 * 不接第三参的旧实现必须照常工作（行为一字不变）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'demo-plugin'
const REGISTRY = 'https://registry.npmjs.org/'
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='

function fakeFetch() {
  return async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        name: TARGET,
        version: '2.0.0',
        engines: { node: '>=22' },
        dist: { tarball: REGISTRY + TARGET + '/-/' + TARGET + '-2.0.0.tgz', integrity: INTEGRITY },
      }),
  })
}

function baseOverrides(extra) {
  let job = null
  return Object.assign(
    {
      runningVersion: '1.0.0',
      profileDir: 'C:\\fake\\profile',
      profileName: 'web',
      homeDir: 'C:\\fake\\home',
      installTimeoutMs: 4321,
      fetchImpl: fakeFetch(),
      now: () => 1_000_000,
      randomId: () => 'id-1',
      nodeVersion: '22.0.0',
      environmentKind: 'cli',
      readInstalled: async () => ({
        profileName: 'web',
        environmentKind: 'cli',
        homeDir: 'C:\\fake\\home',
        profileDir: 'C:\\fake\\profile',
        installedVersion: '1.0.0',
        packageValid: true,
        sourceInstall: false,
        blockedReason: null,
        installationKey: 'k',
        eligible: true,
      }),
      readJob: async () => job,
      writeJob: async (v) => {
        job = v
      },
      releaseGlobalLock: () => {},
      tryAcquireLock: async () => true,
      releaseLock: async () => {},
      backupJob: async () => {},
      runInstall: async () => {},
    },
    extra,
  )
}

async function runInstallOnce(overrides) {
  __resetSharedUpdateReaderForTests()
  const host = createHostUpdate({ readerOverrides: overrides }, { pluginId: TARGET, prefix: 'demo', targetPackageName: TARGET })
  const check = await host.handlers['demo.updateCheck']({})
  assert.equal(check.ok, true, '查新版要先成（装更新要凭证）')
  await host.handlers['demo.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-1' })
}

test('阈值单源：注入的抢全局锁也拿到 installTimeoutMs', async () => {
  const seen = []
  await runInstallOnce(
    baseOverrides({
      tryAcquireGlobalLock: (lockId, pluginId, opts) => {
        seen.push({ lockId, pluginId, opts })
        return true
      },
    }),
  )
  assert.ok(seen.length >= 1, '安装必须走到抢全局锁这一步')
  assert.deepEqual(seen[0].opts, { timeoutMs: 4321 }, '陈旧判据必须与安装时限同源，不许退回空对象让窗口另算')
  assert.equal(seen[0].pluginId, TARGET, '要把插件标识一起给（锁文件里记它）')
})

test('不接第三参的旧实现照常工作（行为一字不变）', async () => {
  let called = 0
  await runInstallOnce(
    baseOverrides({
      tryAcquireGlobalLock: () => {
        called += 1
        return true
      },
    }),
  )
  assert.equal(called, 1, '旧的两参实现照样被调用，不许多要参数才肯干活')
})
