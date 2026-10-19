/**
 * tests/install-output-detail.test.mjs —— 安装失败原文的「生产者」（2026-10-17 对抗审查 #156 B1）。
 *
 * 事实：三条宿主路都把 pnpm 原文交给我们（cli 路的抓取读数、桌面服务路的双流、
 * 管理器路的 packageResult.output），但在此之前**无一处读取**：失败只留一个退出码，
 * 于是 job.message 恒等于 'install-failed'，24h 年龄门的原文到不了面板，
 * 「装合规版」四个入口在生产形状下全都认不出因。
 *
 * 这里逐条钉住：谁读、读哪格、以及原文里的错误码行即使被 300 字封顶挤出头部也要活着。
 * 全用假件：不起真进程、不联网、不写盘。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateExecutor } from '../dist/core/executor.js'
import { interpretInstallCause } from '../dist/core/cause.js'
import { failedJobDiagOf } from '../dist/host.js'
import { fallbackCauseFromDiag } from '../dist/panel.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const REGISTRY = 'https://registry.npmjs.org/'
const MANAGER_KIND = 'desktop-manager'
const TOKEN = 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'
// 30 行进度日志 = 远超 300 封顶，把真正的因挤到尾部；这正是真机上的形状。
const FILLER = 'Progress: resolved 1, reused 0, downloaded 0, added 0\n'.repeat(30)
const CAUSE = ` ${TOKEN}  Cannot install ${TARGET}@0.4.29 because it was published 3 minutes ago\n`

const cliParts = (handle, extra = {}) => ({
  environmentKind: 'cli',
  profileDir: 'C:\\fake\\profile',
  runtimeExecutable: 'C:\\fake\\node.exe',
  runtimeExecArgs: [],
  cliEntry: 'C:\\fake\\cli.js',
  subprocess: { spawn: () => handle },
  pluginId: 'my-plugin',
  log: () => {},
  ...extra,
})

const cliCall = (runInstall) => runInstall({ version: '1.2.3', profileName: 'web', environmentKind: 'cli' })

function fakeStream() {
  const handlers = []
  return {
    on: (event, cb) => {
      if (event === 'data') handlers.push(cb)
    },
    push: (text) => handlers.forEach((cb) => cb(text)),
  }
}

describe('cli 路：宿主抓取读数（handle.collected）里的失败原文', () => {
  it('退出码非 0 时，错误码行从日志尾部挑出来，穿过 300 字封顶活着到 detail', async () => {
    const handle = {
      done: Promise.resolve({ exitCode: 1 }),
      collected: { stdout: { readFrom: () => ({ text: FILLER + CAUSE }) } },
    }
    await assert.rejects(() => cliCall(createUpdateExecutor(cliParts(handle))), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.equal(typeof error.detail, 'string')
      assert.ok(error.detail.includes(TOKEN), `detail 里必须有错误码：${error.detail}`)
      assert.ok(error.detail.length <= 300, `detail 仍受 300 字封顶：${error.detail.length}`)
      return true
    })
  })

  it('真机形状是分行的（签名在上、错误码单独在最后一行）：签名必须跟着一起活下来', async () => {
    // 2026-10-17 #156 第四轮：只取错误码行 → detail 只剩一个 token → interpretInstallCause 认不出因，
    // 四个入口在生产形状下依旧是死的。这一条把「签名和错误码一起活」钉住。
    const REAL = [
      '✗ p@0.4.2: This version was published less than 1440 minutes ago (2026-10-16T05:58:34.000Z).',
      'The minimumReleaseAge cutoff for this version is 2026-10-15T07:34:55.413Z.',
      '',
      'Failed to install p@0.4.2.',
      'Command failed with exit code 1: pnpm add -g p@0.4.2',
      `[${TOKEN}]`,
    ].join('\n')
    const handle = {
      done: Promise.resolve({ exitCode: 1 }),
      collected: { stdout: { readFrom: () => ({ text: FILLER + REAL }) } },
    }
    await assert.rejects(() => cliCall(createUpdateExecutor(cliParts(handle))), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.ok(error.detail.includes(TOKEN), `detail 里必须有错误码：${error.detail}`)
      assert.ok(error.detail.includes('published less than 1440 minutes ago'), `detail 里必须有签名：${error.detail}`)
      assert.ok(error.detail.includes('cutoff'), `detail 里必须有门限：${error.detail}`)
      assert.ok(error.detail.length <= 300, `detail 仍受 300 字封顶：${error.detail.length}`)
      const cause = interpretInstallCause({ errorCode: 'install-failed', detail: error.detail, targetPackageName: 'p' })
      assert.ok(cause, `从 detail 必须能认出因：${error.detail}`)
      assert.equal(cause.kind, 'minimum-release-age')
      assert.equal(cause.blame, 'target')
      assert.equal(cause.spec, 'p@0.4.2')
      assert.equal(cause.windowMinutes, 1440)
      return true
    })
  })

  it('抓取读数只有进度日志、没有错误码行时，退最后一段而不是开头那句进度', async () => {
    const handle = {
      done: Promise.resolve({ exitCode: 1 }),
      collected: { stdout: { readFrom: () => ({ text: FILLER + 'No matching version found for x@9.9.9\n' }) } },
    }
    await assert.rejects(() => cliCall(createUpdateExecutor(cliParts(handle))), (error) => {
      assert.ok(error.detail.includes('No matching version found'), error.detail)
      assert.ok(!error.detail.startsWith('Progress:'), '别把进度日志当因')
      return true
    })
  })

  it('退出码为 0 时不抛、也不因读了抓取读数改变成败判定', async () => {
    const handle = {
      done: Promise.resolve({ exitCode: 0 }),
      collected: { stdout: { readFrom: () => ({ text: FILLER + CAUSE }) } },
    }
    await cliCall(createUpdateExecutor(cliParts(handle)))
  })

  it('老宿主没有 collected 这格：形状与从前一致，只有退出码，不炸不猜', async () => {
    const handle = { done: Promise.resolve({ exitCode: 1 }) }
    await assert.rejects(() => cliCall(createUpdateExecutor(cliParts(handle))), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.equal(error.detail, undefined)
      return true
    })
  })
})

describe('桌面服务路：调用方自己读 handle 双流', () => {
  it('stderr 里的错误码行进 detail（不读双流就永远没有原文）', async () => {
    const runInstall = createUpdateExecutor({
      environmentKind: 'desktop',
      profileDir: 'C:\\fake\\profile',
      desktopProfiles: { current: { dir: 'C:\\fake\\profile' } },
      desktopPnpm: {
        runPlugin: () => {
          const stdout = fakeStream()
          const stderr = fakeStream()
          return {
            stdout,
            stderr,
            done: new Promise((settle) =>
              setTimeout(() => {
                stderr.push(FILLER + CAUSE)
                settle({ exitCode: 1, signal: null })
              }, 0)
            ),
          }
        },
      },
      pluginId: 'my-plugin',
      log: () => {},
    })
    await assert.rejects(() => runInstall({ version: '1.2.3', profileName: 'web', environmentKind: 'desktop' }), (error) => {
      assert.equal(error.code, 'install-failed')
      assert.ok(error.detail.includes(TOKEN), `detail 里必须有错误码：${error.detail}`)
      return true
    })
  })
})

describe('管理器路：packageResult.output 优先于 error 短码', () => {
  it('application=failed 时用 pnpm 原文，而不是只报 error.code', async () => {
    const runInstall = createUpdateExecutor({
      environmentKind: MANAGER_KIND,
      profileName: 'desktop',
      pluginId: 'my-plugin',
      registryUrl: REGISTRY,
      pluginManager: {
        installBundle: () =>
          Promise.resolve({
            application: 'failed',
            error: { code: 'operation-error', diagnostic: 'ERR_PNPM_SOMETHING_ELSE' },
            packageResult: { exitCode: 1, output: FILLER + CAUSE },
          }),
      },
      log: () => {},
    })
    await assert.rejects(
      () => runInstall({ version: '1.2.3', profileName: 'desktop', environmentKind: MANAGER_KIND }),
      (error) => {
        assert.equal(error.code, 'install-failed')
        assert.ok(error.detail.includes(TOKEN), `detail 里必须有错误码：${error.detail}`)
        return true
      }
    )
  })

  it('没有 packageResult 时退回原来的 error 收敛口径，老宿主行为不变', async () => {
    const runInstall = createUpdateExecutor({
      environmentKind: MANAGER_KIND,
      profileName: 'desktop',
      pluginId: 'my-plugin',
      pluginManager: {
        installBundle: () => Promise.resolve({ application: 'failed', error: { code: 'operation-error', diagnostic: '装不上' } }),
      },
      log: () => {},
    })
    await assert.rejects(
      () => runInstall({ version: '1.2.3', profileName: 'desktop', environmentKind: MANAGER_KIND }),
      (error) => {
        assert.ok(error.detail.includes('operation-error'), error.detail)
        assert.ok(error.detail.includes('装不上'), error.detail)
        return true
      }
    )
  })
})

describe('真机形状走完全链：#156 安装原文 → 任务里的原文 → 宿主机读 diag → 面板认因', () => {
  it('分行的真报文在每一棒都不丢签名，最后认得「拦的就是这个包、窗口一小时×24」', async () => {
    // 2026-10-17 #156 第四轮：这条把四棒串起来钉住——只修一棒，用户还是拿不到能装的最新版。
    const REAL = [
      '✗ p@0.4.2: This version was published less than 1440 minutes ago (2026-10-16T05:58:34.000Z).',
      'The minimumReleaseAge cutoff for this version is 2026-10-15T07:34:55.413Z.',
      '',
      'Failed to install p@0.4.2.',
      'Command failed with exit code 1: pnpm add -g p@0.4.2',
      `[${TOKEN}]`,
    ].join('\n')
    const handle = {
      done: Promise.resolve({ exitCode: 1 }),
      collected: { stdout: { readFrom: () => ({ text: FILLER + REAL }) } },
    }
    let detail = ''
    await assert.rejects(() => cliCall(createUpdateExecutor(cliParts(handle))), (error) => {
      detail = String(error.detail)
      assert.ok(detail.includes(TOKEN), `第一棒（store 摘原文）就丢了错误码：${detail}`)
      return true
    })
    // 第二棒：宿主 store 把失败写成任务里那一句（面板/宿主都只看得到这一句）
    const message = 'install-failed: ' + detail
    const snapshot = {
      runningVersion: '0.4.0',
      job: { id: 'j-1', state: 'failed', targetVersion: '0.4.2', message, requestId: 'r-1' },
    }
    // 第三棒：宿主把目标包名与归因补回机读 diag（真宿主的插件标识 life-* 与 npm 包名不同）
    const diag = failedJobDiagOf(snapshot, { targetPackageName: 'p', registryUrl: REGISTRY })
    assert.ok(diag, `宿主必须补出机读 diag；任务里那句是：${message}`)
    assert.equal(diag.causeKind, 'minimum-release-age')
    assert.equal(diag.causePackage, 'p@0.4.2')
    // 第四棒：面板按机读格认因（不再拿插件标识撞包名）
    const cause = fallbackCauseFromDiag(diag, message, 'install-failed', '0.4.2')
    assert.ok(cause, '面板必须认出因，否则「装合规版」是一枚死按钮')
    assert.equal(cause.packageName, 'p')
    assert.equal(cause.targetVersion, '0.4.2')
    assert.equal(cause.windowMs, 1440 * 60000)
    assert.equal(cause.windowSource, 'message')
  })
})
