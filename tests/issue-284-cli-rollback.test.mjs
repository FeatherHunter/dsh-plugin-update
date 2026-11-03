/**
 * tests/issue-284-cli-rollback.test.mjs —— cli 路安装失败后，把 profile 清单的依赖边回滚到装前版本（#284 M3）。
 *
 * 事实（真机 284-20261103T185854）：坏 tarball 让 A 的 pnpm add 失败并把 profile package.json 的依赖边
 * 写成 0.0.2（node_modules 仍是 0.0.1）；随后 B/C 的 pnpm add 解析整份清单都会去拉坏包 → 一行的失败
 * 扩散成整批。修法：只走 cli 路的失败路径（超时/崩溃/非零），当依赖边确实被写到目标版时，用同一载体
 * 跑一次 add 包@装前版本，重读清单+锁核对；结论只拼进 detail 尾巴，原失败码/阶段/原因不变。
 * 全用假件：不起真进程、不联网；profile 目录用系统临时目录（真实写盘，清理干净）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateExecutor } from '../dist/core/executor.js'
import { readInstallFail } from '../dist/core/failure.js'

const TARGET = 'fxa-a'
const PREV = '0.0.1'
const NEXT = '0.0.2'
const EXEC = 'C:\\fake\\node.exe'
const ENTRY = 'C:\\fake\\cli.js'

const manifestOf = (version) => ({
  name: 'profile',
  dependencies: version ? { [TARGET]: version } : {},
})

const lockOf = (version) =>
  [
    'lockfileVersion: \'9.0\'',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      ' + TARGET + ':',
    '        specifier: ' + version,
    '        version: ' + version,
    '',
  ].join('\n')

const makeProfile = async ({ dependency = NEXT, lock = NEXT } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-rollback-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifestOf(dependency), null, 2) + '\n')
  if (lock) await writeFile(join(dir, 'pnpm-lock.yaml'), lockOf(lock))
  return dir
}

const edgeOf = async (dir) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies[TARGET]

// 宿主注入的 subprocess 是带 receiver 的对象：脱离 receiver 调用 spawn 在真机会抛
//（M3 复跑 284-20261103T192601 的「回滚未成功：起不了回滚进程」就是这么来的），假件照同一形态兜住。
const subprocessFor = (spawn) => {
  const subprocess = {
    spawn(opts) {
      if (this !== subprocess) throw new Error('subprocess.spawn 丢 receiver')
      return spawn(opts)
    },
  }
  return subprocess
}

const partsFor = (profileDir, spawn) => ({
  environmentKind: 'cli',
  profileDir,
  runtimeExecutable: EXEC,
  runtimeExecArgs: [],
  cliEntry: ENTRY,
  targetPackageName: TARGET,
  registryUrl: 'http://127.0.0.1:4873',
  subprocess: subprocessFor(spawn),
  pluginId: 'fxa-a',
  log: () => {},
  installTimeoutMs: 200,
})

const call = (runInstall, previousVersion) =>
  runInstall({ version: NEXT, profileName: 'web', environmentKind: 'cli', ...(previousVersion ? { previousVersion } : {}) })

/** 失败时抓 error 与详情，避免断言写两遍。 */
const failureOf = async (runInstall, previousVersion) => {
  let error = null
  await assert.rejects(() => call(runInstall, previousVersion), (thrown) => {
    error = thrown
    return true
  })
  return { error, detail: String(error?.detail ?? ''), facts: readInstallFail(error) }
}

describe('cli 路失败补偿：依赖边回滚到装前版本（#284）', () => {
  it('非零退出且清单被写到目标版：回滚命令用装前版本重跑，成功后详情带「已回滚到」，失败码/原因不变', async (t) => {
    const dir = await makeProfile({ dependency: NEXT, lock: NEXT })
    t.after(() => rm(dir, { recursive: true, force: true }))
    const calls = []
    const spawn = (opts) => {
      calls.push(opts)
      if (calls.length === 1) return { done: Promise.resolve({ exitCode: 1 }), collected: { stdout: { readFrom: () => ({ text: 'ERR_PNPM_TARBALL_INTEGRITY\n' }) } } }
      // 回滚：pnpm 把依赖边写回装前版本后再退出 0。
      return {
        done: (async () => {
          await writeFile(join(dir, 'package.json'), JSON.stringify(manifestOf(PREV), null, 2) + '\n')
          await writeFile(join(dir, 'pnpm-lock.yaml'), lockOf(PREV))
          return { exitCode: 0 }
        })(),
      }
    }
    const { detail, facts } = await failureOf(createUpdateExecutor(partsFor(dir, spawn)), PREV)
    assert.equal(calls.length, 2, '先装一次、再回滚一次')
    assert.deepEqual(calls[1].argv, [
      EXEC,
      ENTRY,
      'plugin',
      '--profile',
      'web',
      'add',
      '--save-exact',
      TARGET + '@' + PREV,
      '--registry=http://127.0.0.1:4873',
    ])
    assert.equal(calls[1].cwd, dir, '回滚必须在同一个 profile 目录里跑')
    assert.equal(await edgeOf(dir), PREV, '重读清单：依赖边回到装前版本')
    assert.ok(detail.includes('ERR_PNPM_TARBALL_INTEGRITY'), '装失败原文仍在前')
    assert.ok(detail.includes('已回滚到 ' + PREV), '详情要写清补偿结果：' + detail)
    assert.ok(detail.length <= 300, '仍守 300 字封顶：' + detail.length)
    assert.equal(facts.reason, 'nonzero-exit')
    assert.equal(facts.stage, 'exec')
    assert.equal(facts.exitCode, 1)
    assert.equal(facts.code, 'install-failed', '原失败码不变，绝不改判成功')
  })

  it('回滚命令本身失败：详情如实说「回滚未成功：…」，清单保持原样，失败原因仍是安装失败', async (t) => {
    const dir = await makeProfile({ dependency: NEXT, lock: NEXT })
    t.after(() => rm(dir, { recursive: true, force: true }))
    const calls = []
    const spawn = (opts) => {
      calls.push(opts)
      if (calls.length === 1) return { done: Promise.resolve({ exitCode: 1 }) }
      return { done: Promise.resolve({ exitCode: 7 }) }
    }
    const { detail, facts } = await failureOf(createUpdateExecutor(partsFor(dir, spawn)), PREV)
    assert.equal(calls.length, 2)
    assert.ok(detail.includes('回滚未成功'), '详情要诚实：' + detail)
    assert.ok(detail.includes('退出码 7'), '要带原始退出码：' + detail)
    assert.equal(await edgeOf(dir), NEXT, '回滚没成功就别假装清单复原')
    assert.equal(facts.reason, 'nonzero-exit')
  })

  it('回滚命令退出 0 但清单没复原：按未回滚记，不拿命令成功冒充清单已复原', async (t) => {
    const dir = await makeProfile({ dependency: NEXT, lock: NEXT })
    t.after(() => rm(dir, { recursive: true, force: true }))
    const calls = []
    const spawn = () => {
      calls.push(1)
      if (calls.length === 1) return { done: Promise.resolve({ exitCode: 1 }) }
      return { done: Promise.resolve({ exitCode: 0 }) }
    }
    const { detail } = await failureOf(createUpdateExecutor(partsFor(dir, spawn)), PREV)
    assert.ok(detail.includes('回滚未成功'), '没核对上就不许说已回滚：' + detail)
    assert.ok(detail.includes('依赖边仍是 ' + NEXT), '如实点名依赖边：' + detail)
    assert.equal(await edgeOf(dir), NEXT)
  })

  it('清单复原但锁文件仍是目标版：同样按未回滚记（锁也核对）', async (t) => {
    const dir = await makeProfile({ dependency: NEXT, lock: NEXT })
    t.after(() => rm(dir, { recursive: true, force: true }))
    const calls = []
    const spawn = () => {
      calls.push(1)
      if (calls.length === 1) return { done: Promise.resolve({ exitCode: 1 }) }
      return {
        done: (async () => {
          await writeFile(join(dir, 'package.json'), JSON.stringify(manifestOf(PREV), null, 2) + '\n')
          return { exitCode: 0 }
        })(),
      }
    }
    const { detail } = await failureOf(createUpdateExecutor(partsFor(dir, spawn)), PREV)
    assert.ok(detail.includes('锁文件里仍是 ' + NEXT), '锁不一致要如实说：' + detail)
  })

  it('依赖边没被写到目标版（还在装前版本）：不发回滚命令，原失败语义一字不动', async (t) => {
    const dir = await makeProfile({ dependency: PREV, lock: PREV })
    t.after(() => rm(dir, { recursive: true, force: true }))
    const calls = []
    const spawn = () => {
      calls.push(1)
      return { done: Promise.resolve({ exitCode: 1 }) }
    }
    const { error, detail, facts } = await failureOf(createUpdateExecutor(partsFor(dir, spawn)), PREV)
    assert.equal(calls.length, 1, '没有毒化就不许动清单')
    assert.ok(!detail.includes('回滚'), '不该出现补偿叙述：' + detail)
    assert.equal(facts.reason, 'nonzero-exit')
    assert.equal(error.code, 'install-failed')
  })

  it('没带 previousVersion：与从前完全一致，不读清单不发回滚', async (t) => {
    const dir = await makeProfile({ dependency: NEXT, lock: NEXT })
    t.after(() => rm(dir, { recursive: true, force: true }))
    const calls = []
    const spawn = () => {
      calls.push(1)
      return { done: Promise.resolve({ exitCode: 1 }) }
    }
    const { error } = await failureOf(createUpdateExecutor(partsFor(dir, spawn)))
    assert.equal(calls.length, 1)
    assert.equal(error.code, 'install-failed')
    assert.equal(readInstallFail(error).reason, 'nonzero-exit')
  })

  it('超时路径：先终止再核对，进程已退出才回滚；详情仍点名超时并带补偿结论', async (t) => {
    const dir = await makeProfile({ dependency: NEXT, lock: NEXT })
    t.after(() => rm(dir, { recursive: true, force: true }))
    let settleInstall = null
    let installHandle = null
    let terminated = 0
    let rollbackCalls = 0
    const spawn = (opts) => {
      if (!installHandle) {
        installHandle = {
          done: new Promise((resolve) => {
            settleInstall = resolve
          }),
          terminate: () => {
            terminated += 1
          },
        }
        return installHandle
      }
      rollbackCalls += 1
      return {
        done: (async () => {
          await writeFile(join(dir, 'package.json'), JSON.stringify(manifestOf(PREV), null, 2) + '\n')
          await writeFile(join(dir, 'pnpm-lock.yaml'), lockOf(PREV))
          return { exitCode: 0 }
        })(),
      }
    }
    const executor = createUpdateExecutor({ ...partsFor(dir, spawn), installTimeoutMs: 40 })
    const pending = failureOf(executor, PREV)
    // 到点被终止之后再让子进程退出（模拟真机 terminate 后它随后退出）：宽限窗口内确认它真退了才回滚。
    setTimeout(() => settleInstall({ exitCode: null }), 90)
    const { detail, facts } = await pending
    assert.equal(terminated, 1)
    assert.equal(rollbackCalls, 1, '超时且清单被写坏时要回滚')
    assert.equal(await edgeOf(dir), PREV)
    assert.equal(facts.reason, 'timeout')
    assert.ok(detail.includes('安装超时'), '超时口径要保留：' + detail)
    assert.ok(detail.includes('已回滚到 ' + PREV), '补偿结论跟着在后面：' + detail)
  })

  it('集成式：第一行失败并回滚后，第二行拿到的清单是干净装前版本（不再被坏包拖垮）', async (t) => {
    const dir = await makeProfile({ dependency: NEXT, lock: NEXT })
    t.after(() => rm(dir, { recursive: true, force: true }))
    const calls = []
    const spawn = (opts) => {
      calls.push(opts)
      if (calls.length === 1) return { done: Promise.resolve({ exitCode: 1 }) }
      if (calls.length === 2) {
        return {
          done: (async () => {
            await writeFile(join(dir, 'package.json'), JSON.stringify(manifestOf(PREV), null, 2) + '\n')
            await writeFile(join(dir, 'pnpm-lock.yaml'), lockOf(PREV))
            return { exitCode: 0 }
          })(),
        }
      }
      // 第二行安装：确认拿到的清单是干净装前版本（仍是被毒化的版本就以失败收尾，让测试红）。
      return {
        done: (async () => {
          const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
          if (manifest.dependencies[TARGET] !== PREV) {
            return { exitCode: 1 }
          }
          await writeFile(join(dir, 'package.json'), JSON.stringify(manifestOf(NEXT), null, 2) + '\n')
          await writeFile(join(dir, 'pnpm-lock.yaml'), lockOf(NEXT))
          return { exitCode: 0 }
        })(),
      }
    }
    const executor = createUpdateExecutor(partsFor(dir, spawn))
    await failureOf(executor, PREV)
    await call(executor, PREV)
    assert.equal(calls.length, 3, '第一行装+回滚，第二行装（第二行若看到毒化清单会以 exitCode 1 收尾并使本测试失败）')
    assert.deepEqual(calls[2].argv.slice(-3), ['--save-exact', TARGET + '@' + NEXT, '--registry=http://127.0.0.1:4873'])
    assert.equal(await edgeOf(dir), NEXT, '第二行正常完成')
  })
})
