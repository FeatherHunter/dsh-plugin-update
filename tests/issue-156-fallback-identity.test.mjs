/**
 * tests/issue-156-fallback-identity.test.mjs —— #156 第四轮对抗审查：异步安装失败的「身份」。
 *
 * 现场事实（真宿主形状）：安装是异步的——年龄门拦在安装那一刻，安装电话回包照旧 ok:true，
 * 真正的失败落在之后的快照任务里，而任务里只剩「失败码 + 原文」。原文要认出因必须知道**包名**，
 * 可面板手里只有**插件标识**；真宿主的标识是 `life-<key>` 这类派生值，与 npm 包名不是一回事
 * ——于是「装合规版」在真机上永远不出现（fail-closed 成一枚死按钮）。
 *
 * 修法：宿主按同一套 buildDiag 把目标包名补回 diag（host.ts 的 failedJobDiagOf），
 * 三个入口改认机读诊断（panel.ts 的 fallbackCauseFromDiag）。
 *
 * 本文件只测外部行为：真宿主电话（createHostUpdate handlers）产出的 diag，
 * 以及三个面板入口在「标识 ≠ 包名」形状下的纯函数结论。不测内部实现。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { fallbackCauseFromDiag } from '../dist/panel.js'
import { installButtonViewModel } from '../dist/install-button.js'
import { batchFallbackCauseOf } from '../dist/panel-batch.js'

const TARGET = 'p'
const ID = 'life-p' // 真宿主形状：插件标识与 npm 包名不是一回事

const AGE_TEXT = [
  `✗ ${TARGET}@0.4.2: This version was published less than 1440 minutes ago (2026-10-16T05:58:34.000Z).`,
  'The minimumReleaseAge cutoff for this version is 2026-10-15T07:34:55.413Z.',
  '',
  `Failed to install ${TARGET}@0.4.2.`,
  'Command failed with exit code 1: pnpm add -g p@0.4.2',
  '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]',
].join('\n')
const AGE_MESSAGE = `install-failed: ${AGE_TEXT}`
const AGE_DETAIL = AGE_TEXT

/** 宿主现在会补的机读诊断（形状与真宿主一致：causeKind/causePackage/targetPackageName）。 */
const HOST_DIAG = {
  v: 1,
  stage: 'exec',
  detail: AGE_TEXT,
  targetPackageName: TARGET,
  runningVersion: '0.4.0',
  registryHost: 'registry.npmjs.org',
  causeKind: 'minimum-release-age',
  causePackage: `${TARGET}@0.4.2`,
  causeUnlockAt: 1_792_000_000_000,
  action: 'contact',
}

function snapshotFailed(over = {}) {
  return {
    runningVersion: '0.4.0',
    installedVersion: '0.4.0',
    latestVersion: '0.4.2',
    canInstall: true, // 生产真形状：门在安装那一刻才拦，canInstall 仍在
    blockedReason: null,
    installed: true,
    job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: AGE_MESSAGE, requestId: 'req-1' },
    ...over,
  }
}

function batchRow(over = {}) {
  return {
    key: 'p',
    title: 'P 插件',
    phase: 'failed',
    targetVersion: '0.4.2',
    restartRequired: false,
    error: 'install-failed',
    snapshot: snapshotFailed(),
    manual: null,
    queue: null,
    profileName: null,
    pluginId: ID,
    phoneNames: { updateCheck: 'p.updateCheck', updateInstall: 'p.updateInstall', updateCheckFallback: 'p.updateCheckFallback' },
    ...over,
  }
}

describe('#156 第四轮：机读诊断 → 兜底结论（纯函数）', () => {
  it('身份来自诊断（宿主事实），时间来自原文：标识与包名无关也认得出', () => {
    const cause = fallbackCauseFromDiag(HOST_DIAG, AGE_DETAIL, 'install-failed')
    assert.ok(cause)
    assert.equal(cause.kind, 'minimum-release-age')
    assert.equal(cause.target, TARGET)
    assert.equal(cause.spec, `${TARGET}@0.4.2`)
    assert.equal(cause.targetVersion, '0.4.2')
    assert.equal(cause.windowMs, 86_400_000, '报文自述 1440 分钟 → 窗口照收')
    assert.equal(cause.windowSource, 'message')
  })

  it('原文认不出（只剩诊断）：身份照给，窗口留空交决议侧反推——不猜', () => {
    const cause = fallbackCauseFromDiag(HOST_DIAG, null, 'install-failed')
    assert.ok(cause)
    assert.equal(cause.targetVersion, '0.4.2')
    assert.equal(cause.windowMs, null)
    assert.equal(cause.windowSource, 'unknown')
  })

  it('B 类（诊断说的是别家包，宿主目标仍是本插件）：null——不指手画脚', () => {
    const other = { ...HOST_DIAG, causePackage: 'other@9.9.9' }
    assert.equal(fallbackCauseFromDiag(other, AGE_TEXT.replaceAll('p@0.4.2', 'other@9.9.9'), 'install-failed'), null)
  })

  it('诊断缺目标包名（老宿主/无诊断）：null——退回老路，最坏就是现在', () => {
    const noTarget = { ...HOST_DIAG, targetPackageName: undefined }
    assert.equal(fallbackCauseFromDiag(noTarget, AGE_DETAIL, 'install-failed'), null)
    assert.equal(fallbackCauseFromDiag(null, AGE_DETAIL, 'install-failed'), null)
  })
})

describe('#156 第四轮：槽位安装按钮（生产形状：标识 ≠ 包名）', () => {
  const base = {
    snapshot: snapshotFailed(),
    manual: null,
    queue: null,
    lastError: 'install-failed',
    errorKind: 'install-failed',
    errorDetail: AGE_DETAIL,
    pluginId: ID,
    busyAct: null,
  }

  it('带宿主诊断：认得出因 → 给[装合规版]，主按钮照旧并存', () => {
    const view = installButtonViewModel({ ...base, errorDiag: HOST_DIAG })
    assert.equal(view.fallbackStage, 'offer')
    assert.equal(view.role, 'install')
    assert.equal(view.buttonEnabled, true)
  })

  it('对抗反证：同一份原文、没有诊断 → 认不出（真机上过去就是这个形状，死按钮）', () => {
    const view = installButtonViewModel({ ...base, errorDiag: null })
    assert.equal(view.fallbackStage, null)
  })
})

describe('#156 第四轮：批量行（生产形状：标识 ≠ 包名）', () => {
  it('带宿主诊断：行内给[装合规版]', () => {
    const cause = batchFallbackCauseOf(batchRow({ diag: HOST_DIAG }))
    assert.ok(cause)
    assert.equal(cause.targetVersion, '0.4.2')
    assert.equal(cause.kind, 'minimum-release-age')
  })

  it('对抗反证：同一行、没有诊断 → 行内无按钮（真机上过去就是这个形状）', () => {
    assert.equal(batchFallbackCauseOf(batchRow({ diag: null })), null)
  })
})

describe('#156 第四轮：宿主把包名补回成功回包（真电话）', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })

  function memoryStore() {
    let job = null
    let locked = null
    return {
      readJob: async () => job,
      writeJob: async (value) => {
        job = value
      },
      tryAcquireLock: async (id) => {
        if (locked !== null) return false
        locked = id
        return true
      },
      releaseLock: async (id) => {
        if (locked === id) locked = null
      },
      backupJob: async () => {},
    }
  }

  function makeHost(runInstall) {
    const store = memoryStore()
    return createHostUpdate(
      {
        readerOverrides: {
          runningVersion: '0.4.0',
          profileDir: 'C:\\fake\\profile',
          profileName: 'web',
          homeDir: 'C:\\fake\\home',
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                name: TARGET,
                version: '0.4.2',
                engines: { node: '>=22' },
                dist: {
                  tarball: `https://registry.npmjs.org/${TARGET}/-/${TARGET}-0.4.2.tgz`,
                  integrity: 'sha512-' + 'A'.repeat(86) + '==',
                },
              }),
          }),
          now: () => 1_000_000,
          randomId: (() => {
            let n = 0
            return () => `id-${(n += 1)}`
          })(),
          nodeVersion: '22.0.0',
          environmentKind: 'cli',
          targetPackageName: TARGET,
          readInstalled: async () => ({
            profileName: 'web',
            environmentKind: 'cli',
            homeDir: 'C:\\fake\\home',
            profileDir: 'C:\\fake\\profile',
            installedVersion: '0.4.0',
            packageValid: true,
            sourceInstall: false,
            blockedReason: null,
            installationKey: 'fake-key',
            eligible: true,
          }),
          ...store,
          runInstall,
        },
      },
      { pluginId: ID, prefix: 'p', targetPackageName: TARGET },
    )
  }

  it('被年龄门拦下：安装回包 ok:true，之后查状态的**成功**回包带宿主包名的 diag（端到端认因）', async () => {
    const host = makeHost(async () => {
      throw Object.assign(new Error(AGE_TEXT), { code: 'install-failed', detail: AGE_TEXT })
    })
    const check = await host.handlers['p.updateCheck']({})
    assert.equal(check.ok, true)
    const install = await host.handlers['p.updateInstall']({ checkId: check.receipt.checkId, requestId: 'req-age' })
    assert.equal(install.ok, true, '安装是异步的：被门拦下也先回 ok')

    let status = null
    for (let i = 0; i < 200; i += 1) {
      status = await host.handlers['p.updateStatus']({})
      if (status.snapshot?.job?.state === 'failed') break
      await new Promise((r) => setTimeout(r, 0))
    }
    assert.equal(status.snapshot.job.state, 'failed')
    assert.ok(status.diag, '失败任务躺在快照里：成功回包也要把机读诊断带上')
    assert.equal(status.diag.targetPackageName, TARGET, '包名是宿主的，不是插件标识')
    assert.equal(status.diag.causeKind, 'minimum-release-age')
    assert.equal(status.diag.causePackage, `${TARGET}@0.4.2`)

    // 端到端：面板的纯函数按诊断认出「拦的正是这个包」，与标识无关。
    const cause = fallbackCauseFromDiag(status.diag, AGE_DETAIL, 'install-failed')
    assert.equal(cause?.kind, 'minimum-release-age')
    assert.equal(cause?.targetVersion, '0.4.2')
  })

  it('没有失败任务：成功回包一个 diag 键都不带（老形状逐字不变）', async () => {
    const host = makeHost(async () => {})
    const out = await host.handlers['p.updateStatus']({})
    assert.equal(out.ok, true)
    assert.ok(!('diag' in out))
  })
})
