/**
 * tests/issue-151-expiry-refetch.test.mjs —— #151：过期重查与装时重验的取数必须可数。
 *
 * 只测外部行为：单宿主三电话，手动把时钟拨过凭证有效期。
 * 取数恰好 3 次 = 预查 1 + 过期后重查 1 + 装时重验 1，全串行、零并发、零单例竞态。
 *
 * 为什么从批量用例搬到这里：原 `tests/batch-host.test.mjs`“真路径两家批”断言
 * registry 取数恰好 6 次，但两家预查并发触及读取器工厂时，先后顺序由
 * `resolveTargetPackage` 的真实文件 I/O 竞态决定（`src/host.ts` 单例只留最后
 * 创建的那家，与预查完成顺序无关）；先创建的恰是后装的那家时，首次提交命中
 * 自家槽位、无需重查，实测 5 次。500ms 读延迟只能定完成顺序，定不了创建顺序，
 * 所以 6 次的断言在该场景下不可达到确定性（干净树复现约 1/2 红）。
 * ADR-0004 §3 的数字（重查必联网、装时必重验）改由本用例锁定：
 * 将来谁按“装阶段不重查”优化，必须先来改这里的断言。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { DEFAULT_CONFIRMATION_TTL_MS } from '../dist/shared/config.js'

const TARGET = 'pkg-expiry'
const REGISTRY = 'https://registry.npmjs.org/'

function makeHost() {
  let fetches = 0
  let clock = 1_000_000
  let job = null
  let n = 0
  const host = createHostUpdate(
    {
      logCtx: null,
      readerOverrides: {
        runningVersion: '1.0.0',
        profileDir: 'C:\\fake\\profile',
        profileName: 'web',
        homeDir: 'C:\\fake\\home',
        fetchImpl: async () => {
          fetches += 1
          return {
            ok: true,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                name: TARGET,
                version: '2.0.0',
                engines: { node: '>=22' },
                dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-2.0.0.tgz`, integrity: 'sha512-' + 'A'.repeat(86) + '==' },
              }),
          }
        },
        now: () => clock,
        randomId: () => `id-${(n += 1)}`,
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        readInstalled: async () => ({
          profileName: 'web',
          environmentKind: 'cli',
          homeDir: 'C:\\fake\\home',
          profileDir: 'C:\\fake\\profile',
          installedVersion: '1.0.0',
          packageValid: true,
          sourceInstall: false,
          blockedReason: null,
          installationKey: 'fake-key',
          eligible: true,
        }),
        readJob: async () => job,
        writeJob: async (value) => {
          job = value
        },
        tryAcquireLock: async () => true,
        releaseLock: async () => {},
        backupJob: async () => {},
        runInstall: async () => {},
      },
    },
    { pluginId: 'dsh-expiry-probe', prefix: 'ex' },
  )
  return {
    host,
    fetchCount: () => fetches,
    expireReceipt: () => {
      clock += DEFAULT_CONFIRMATION_TTL_MS + 1
    },
  }
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

describe('issue-151：过期重查与装时重验必联网', () => {
  it('凭证过期提交被拒 → 重查拿新凭证 → 重装，取数恰好 3 次', async () => {
    const { host, fetchCount, expireReceipt } = makeHost()
    const check = host.handlers['ex.updateCheck']
    const install = host.handlers['ex.updateInstall']

    const first = await check({})
    assert.equal(first.ok, true)
    assert.equal(first.receipt?.checkId, 'id-1')
    assert.equal(fetchCount(), 1, '预查联网一次')

    expireReceipt()
    const stale = await install({ checkId: 'id-1', requestId: 'req-1' })
    assert.equal(stale.ok, false)
    assert.equal(stale.error, 'check-expired', '过期凭证提交必须被拒')
    assert.equal(fetchCount(), 1, '被拒不能触发取数')

    const second = await check({})
    assert.equal(second.ok, true)
    assert.equal(second.receipt?.checkId, 'id-2', '重查必须发新凭证')
    assert.equal(fetchCount(), 2, '重查必须重新联网，不许复用上次结果')

    const done = await install({ checkId: 'id-2', requestId: 'req-2' })
    assert.equal(done.ok, true, '新凭证提交必须受理')
    assert.equal(fetchCount(), 3, '装时必须按版本文档重验一次远端')
  })
})
