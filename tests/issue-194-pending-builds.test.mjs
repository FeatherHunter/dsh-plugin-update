/**
 * tests/issue-194-pending-builds.test.mjs —— 需要批准的构建脚本通道（#194，S2）。
 *
 * 宿主契约（asar dsh-plugin-manager/lib/index.js:2033-2061）：pnpm 失败时把
 * `recordPendingBuilds()` 的结果写进 `result.pendingBuilds`（等待构建决策的**精确包名**，
 * 不含通配规则；同时把 allowBuilds 里写成 UNDECIDED），再 throw；`change()` 把它折进
 * `{application:'failed', error}` 的 resolve 回包——于是 `pendingBuilds` 格还在。
 * 重试时宿主接受 `installBundle(spec, {approvedBuilds:[名字]})`：先 approveBuilds 再跑 pnpm。
 *
 * 本包此前只声明 application/error/packageResult，pendingBuilds 被丢掉、也不接受批准重试
 * ⇒ 需要 postinstall/原生构建的包永远 install-failed 且不解释。
 *
 * 这里只走公开入口：
 * A. `createUpdateExecutor`（dist/core/executor.js）+ 假管理器：失败回包点名包名、给批准后重试的路径、
 *    守 300 字上限与「原文在前」；approvedBuilds 重试原样进宿主选项；畸形输入一律过滤；
 * B. `createHostUpdate`（dist/host.js）安装电话：approvedBuilds 从电话参数进到 runInstall 端口。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createUpdateExecutor } from '../dist/core/executor.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { normalizeApprovedBuilds } from '../dist/shared/commands.js'

const TARGET = 'native-plugin-under-test'
const SPEC = `${TARGET}@2.0.0`
const MANAGER_KIND = 'desktop-manager'
const REGISTRY = 'https://registry.npmjs.org/'
/** 失败原文里的探针串：详情必须「原文在前、本包建议在后」。 */
const RAW_MARKER = 'ERR_PNPM_IGNORED_BUILDS'
const RAW_OUTPUT = `${RAW_MARKER} Ignored build scripts: native-a, native-b`
const BUILD_HINT = '需要批准构建脚本'

const tmpRoots = []
after(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scripted(script = {}) {
  const calls = { install: [], remove: [], cancel: [] }
  const next = (list, fallback) => (Array.isArray(list) && list.length > 0 ? list.shift() : fallback)
  const answer = (step) => {
    if (step instanceof Error) return Promise.reject(step)
    if (typeof step === 'function') return Promise.resolve().then(() => step())
    return Promise.resolve(step)
  }
  const manager = {
    calls,
    installBundle(spec, options) {
      calls.install.push({ spec, options })
      return answer(next(script.install, { application: 'applied' }))
    },
    cancelInstall() {
      return Promise.resolve({ status: 'not-running' })
    },
  }
  if (script.remove !== false) {
    manager.removeBundle = (name) => {
      calls.remove.push([name])
      return answer(next(script.remove, { application: 'applied' }))
    }
  }
  return manager
}

/** 宿主 pnpm 失败后的真实回包形状：application 失败 + pnpm 原文/退码 + 待批构建名单。 */
const pendingBuildFailure = (names = ['native-a', 'native-b']) => ({
  application: 'failed',
  error: { code: 'operation-error', diagnostic: 'pnpm failed' },
  packageResult: { output: RAW_OUTPUT, exitCode: 1 },
  pendingBuilds: names,
})

const runWith = (parts) =>
  createUpdateExecutor({ environmentKind: MANAGER_KIND, profileName: 'desktop', pluginId: 'my-plugin', ...parts })
const call = (runInstall, extra = {}) =>
  runInstall({ version: '2.0.0', profileName: 'desktop', environmentKind: MANAGER_KIND, ...extra })

async function rejectedOf(run) {
  let error = null
  try {
    await run()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, '这次调用必须失败，但它 resolve 了')
  return error
}

describe('#194 管理器路：需要批准的构建脚本要解释清楚、可带批准重试', () => {
  it('宿主回 pendingBuilds：详情点名包名、给批准路径、原文在前，且不冒充成功', async () => {
    const manager = scripted({ install: [pendingBuildFailure(['native-a', 'native-b'])] })
    const error = await rejectedOf(() => call(runWith({ registryUrl: REGISTRY, pluginManager: manager })))

    assert.equal(error.code, 'install-failed')
    const detail = String(error.detail ?? '')
    assert.ok(detail.length > 0, '人话格不能为空')
    assert.ok(detail.includes(`${BUILD_HINT}：native-a、native-b`), `点名这两个包：${detail}`)
    assert.ok(detail.includes('请先批准构建脚本'), '给出批准后再试的下一步')
    assert.ok(
      detail.includes('dsh plugin --profile desktop approve-builds'),
      '给出载体 CLI 的批准命令（pnpm approve-builds 经 dsh plugin 转发）'
    )
    assert.ok(detail.indexOf(RAW_MARKER) < detail.indexOf(BUILD_HINT), '宿主原文必须在前、建议在后')
    assert.ok(detail.length <= 300, `人话格超 300 字：${detail.length}`)
  })

  it('带 approvedBuilds 重试：批准名单原样进宿主选项，成功即成功', async () => {
    const manager = scripted({
      install: [pendingBuildFailure(), { application: 'restart-required' }],
    })
    const run = runWith({ registryUrl: REGISTRY, pluginManager: manager })

    await rejectedOf(() => call(run))
    await call(run, { approvedBuilds: ['native-a', 'native-b'] })

    assert.equal(manager.calls.install.length, 2)
    const retry = manager.calls.install[1]
    assert.deepEqual(retry.options.approvedBuilds, ['native-a', 'native-b'], '批准名单要原样交给宿主 approveBuilds')
    assert.equal(retry.options.registry, REGISTRY)
  })

  it('畸形 pendingBuilds 只认精确包名：非字符串、通配、开关样式一律不点名', async () => {
    const manager = scripted({
      install: [pendingBuildFailure(['ok-a', 42, '', '--registry=https://evil', 'glob*', 'ok-b', 'ok-a'])],
    })
    const error = await rejectedOf(() => call(runWith({ registryUrl: REGISTRY, pluginManager: manager })))

    const detail = String(error.detail ?? '')
    assert.ok(detail.includes(`${BUILD_HINT}：ok-a、ok-b`), `只留精确名字并去重：${detail}`)
    assert.ok(!detail.includes('--registry='), '开关样式不能进人话格/命令')
    assert.ok(!detail.includes('glob*'), '通配规则不是精确包名')
  })

  it('名单很长很多：仍守 300 字上限，但批准命令与「等 N 个」退让都在', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `native-package-with-a-long-name-${String(i).padStart(2, '0')}`)
    const manager = scripted({ install: [pendingBuildFailure(names)] })
    const error = await rejectedOf(() => call(runWith({ registryUrl: REGISTRY, pluginManager: manager })))

    const detail = String(error.detail ?? '')
    assert.ok(detail.includes(BUILD_HINT), detail)
    assert.ok(detail.includes('native-package-with-a-long-name-00'), '长名单也要至少点名第一个包')
    assert.ok(detail.includes('等 8 个'), '点不全时如实说还有多少个')
    assert.ok(
      detail.includes('dsh plugin --profile desktop approve-builds'),
      'Spec 审查 HARD：长名单的批准命令不能丢（宿主页批准入口只在它自己的安装失败页）'
    )
    assert.ok(detail.length <= 300, `人话格超 300 字：${detail.length}`)
  })

  it('批准名单本身也要过滤：全是无效项时不给宿主传这个选项', async () => {
    const manager = scripted({ install: [{ application: 'applied' }] })
    await call(runWith({ registryUrl: REGISTRY, pluginManager: manager }), {
      approvedBuilds: ['--evil', 'wild*', '', 7],
    })

    const first = manager.calls.install[0]
    assert.equal(Object.hasOwn(first.options, 'approvedBuilds'), false, '没一个合法包名就不要传 approvedBuilds')
  })

  it('普通失败（无 pendingBuilds）不出现批准话术，避免误导', async () => {
    const manager = scripted({
      install: [{ application: 'failed', error: { code: 'operation-error' }, packageResult: { output: 'net ENOTFOUND', exitCode: 1 } }],
    })
    const error = await rejectedOf(() => call(runWith({ registryUrl: REGISTRY, pluginManager: manager })))
    const detail = String(error.detail ?? '')
    assert.ok(!detail.includes(BUILD_HINT), `没有待批构建就不要出现批准话术：${detail}`)
  })

  it('已装包两步配方的第二次安装也需要批准时，同样点名并保留「包已被移除」事实', async () => {
    const manager = scripted({
      install: [
        { application: 'failed', error: { code: 'already-installed' } },
        pendingBuildFailure(['native-a']),
      ],
      remove: [{ application: 'applied' }],
    })
    const error = await rejectedOf(() =>
      call(runWith({ registryUrl: REGISTRY, pluginManager: manager, approvedBuilds: ['native-a'] }))
    )

    const detail = String(error.detail ?? '')
    assert.ok(detail.includes(`${BUILD_HINT}：native-a`), `第二次安装也要点名：${detail}`)
    assert.ok(detail.includes('已被宿主移除'), `要保留移除事实：${detail}`)
    assert.ok(detail.includes('不在使用范围'), `要说清包现在不在册：${detail}`)
    assert.ok(detail.length <= 300, `人话格超 300 字：${detail.length}`)
    // 批准名单要走完两次 installBundle（首装 + 移除后重装，共用同一 optionsFor）。
    assert.equal(manager.calls.install.length, 2, '两步配方应调用两次 installBundle')
    assert.deepEqual(manager.calls.install[0].options.approvedBuilds, ['native-a'], '首装也要带批准名单')
    assert.deepEqual(manager.calls.install[1].options.approvedBuilds, ['native-a'], '移除后重装也要带批准名单')
  })

  it('两步配方 + 长 pnpm 原文：批准建议与「包已被移除」事实必须同时活下来（审查 HARD 回归）', async () => {
    const longOutput = `${RAW_MARKER} ${'native build log line；'.repeat(40)}`
    const manager = scripted({
      install: [
        { application: 'failed', error: { code: 'already-installed' } },
        { ...pendingBuildFailure(['native-a', 'native-b']), packageResult: { output: longOutput, exitCode: 1 } },
      ],
      remove: [{ application: 'applied' }],
    })
    const error = await rejectedOf(() => call(runWith({ registryUrl: REGISTRY, pluginManager: manager })))

    const detail = String(error.detail ?? '')
    assert.ok(detail.includes(`${BUILD_HINT}：native-a、native-b`), `长原文不得吞掉批准名单：${detail}`)
    assert.ok(detail.includes('请先批准构建脚本'), '批准路径必须保留')
    assert.ok(detail.includes('已被宿主移除'), '移除事实必须保留')
    assert.ok(detail.length <= 300, `人话格超 300 字：${detail.length}`)
  })

  it('首装 + 长 pnpm 原文：原文在前，批准建议不被截掉', async () => {
    const longOutput = `${RAW_MARKER} ${'x'.repeat(1500)}`
    const manager = scripted({
      install: [{ ...pendingBuildFailure(['native-a']), packageResult: { output: longOutput, exitCode: 1 } }],
    })
    const error = await rejectedOf(() => call(runWith({ registryUrl: REGISTRY, pluginManager: manager })))

    const detail = String(error.detail ?? '')
    assert.ok(detail.includes(`${BUILD_HINT}：native-a`), `长原文不得吞掉批准建议：${detail}`)
    assert.ok(detail.indexOf(RAW_MARKER) === 0, '宿主原文必须仍在最前')
    assert.ok(detail.length <= 300, `人话格超 300 字：${detail.length}`)
  })
})

describe('#194 安装电话：approvedBuilds 从入参送到安装端口', () => {
  function memoryStore() {
    let job = null
    return {
      readJob: async () => job,
      writeJob: async (value) => {
        job = value
      },
      tryAcquireLock: async () => true,
      releaseLock: async () => {},
      backupJob: async () => {},
      /** 测试观察点：连接器最终记住的任务（用来断言入参不被持久化）。 */
      current: () => job,
    }
  }

  function writeJson(p, obj) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
  }

  function makeTargetPackage(dir, version) {
    writeJson(join(dir, 'package.json'), {
      name: TARGET,
      version,
      main: './index.js',
      exports: { './client': './client.js' },
      dsh: { bundle: { patch: './patch.js' } },
    })
    writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
    writeFileSync(join(dir, 'client.js'), 'module.exports = {}\n')
    writeFileSync(join(dir, 'patch.js'), 'module.exports = {}\n')
  }

  function makeHost() {
    const profileDir = mkdtempSync(join(tmpdir(), 'dpu-194-'))
    tmpRoots.push(profileDir)
    writeJson(join(profileDir, 'package.json'), {
      name: 'fake-profile',
      version: '0.0.0',
      dependencies: { [TARGET]: '^1.0.0' },
    })
    makeTargetPackage(join(profileDir, 'node_modules', TARGET), '1.0.0')
    const runCalls = []
    const latest = async (url) => {
      assert.equal(url, `${REGISTRY}${encodeURIComponent(TARGET)}/latest`)
      return {
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            name: TARGET,
            version: '2.0.0',
            engines: { node: '>=22' },
            dist: { tarball: `${REGISTRY}${TARGET}/-/native-plugin-under-test-2.0.0.tgz`, integrity: 'sha512-' + 'A'.repeat(86) + '==' },
          }),
      }
    }
    const store = memoryStore()
    const host = createHostUpdate(
      {
        logCtx: { fire: () => {} },
        readerOverrides: {
          runningVersion: '1.0.0',
          targetPackageDir: join(profileDir, 'node_modules', TARGET),
          profileDir,
          profileName: 'desktop',
          homeDir: profileDir,
          fetchImpl: async (url) => latest(url),
          now: () => 1_000_000,
          randomId: () => `id-${runCalls.length + 1}`,
          nodeVersion: '22.0.0',
          environmentKind: 'cli',
          targetPackageName: TARGET,
          runInstall: async (args) => {
            runCalls.push(args)
            makeTargetPackage(join(profileDir, 'node_modules', TARGET), args.version)
          },
          ...store,
        },
      },
      { pluginId: 'issue-194-plugin', prefix: 'issue194', targetPackageName: TARGET }
    )
    return { host, runCalls, store }
  }

  it('updateInstall 的 approvedBuilds 进 runInstall 端口；无效项被过滤', async () => {
    __resetSharedUpdateReaderForTests()
    const { host, runCalls, store } = makeHost()
    const check = await host.handlers['issue194.updateCheck']({})
    const checkId = check.receipt.checkId
    await host.handlers['issue194.updateInstall']({
      checkId,
      requestId: 'req-194-1',
      approvedBuilds: ['native-a', '--evil', 'native-b'],
    })

    assert.equal(runCalls.length, 1, '安装必须真的启动了')
    assert.deepEqual(runCalls[0].approvedBuilds, ['native-a', 'native-b'], '电话入参要过滤后原样交给安装端口')
    const job = store.current()
    assert.ok(job && typeof job === 'object', '安装必须建出任务')
    assert.ok(!Object.hasOwn(job, 'approvedBuilds'), `批准名单只能活在本次调用，不得进任务/落盘：${JSON.stringify(job)}`)
  })
})

describe('#194 批准名单归一：形状守 npm 包名文法', () => {
  it('去重保序、超过 32 条截断', () => {
    const many = Array.from({ length: 40 }, (_, i) => `native-${String(i).padStart(2, '0')}`)
    const names = normalizeApprovedBuilds([...many, 'native-00'])
    assert.equal(names.length, 32, '上限 32 条')
    assert.equal(names[0], 'native-00', '保序')
    assert.equal(names[31], 'native-31', '按输入顺序截断')
    assert.equal(new Set(names).size, names.length, '不允许重复')
  })

  it('接受 scoped 名，拒绝路径片段/包@版本/通配/开关样式/非字符串', () => {
    assert.deepEqual(
      normalizeApprovedBuilds(['@scope/native-a', '../native-a', 'a/b/c', 'native-a@2.0.0', 'native-*', '--registry=x', 7, '']),
      ['@scope/native-a'],
      '只有合法包名能进入批准名单'
    )
  })
})
