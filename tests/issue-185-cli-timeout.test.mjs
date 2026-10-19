/**
 * tests/issue-185-cli-timeout.test.mjs —— cli 路的超时不许再折成「普通安装失败」（2026-10-17 对抗审查 A 线 R4 / #185）。
 *
 * 事实：出口三（cli-process）到点确实终止了子进程，但 `awaitOutcome` 把「超时」与「done reject」
 * 都折成 timedOut:true，调用方只拿抓取读数当详情——没有输出就是空。用户读到的是通用兜底文案，
 * 不知道是超时，更不知道进程已经被终止。出口二（管理器）同一件事早有冻结中文，两条路两种口径。
 *
 * 这里逐条钉住：三态分开（自己收尾 / 崩了 / 到点）、超时详情点名超时且按「有没有终止能力」说人话、
 * 到点后宽限内自己成功收尾仍算成功、原文永远在前口径永远在后。全用假件：不起真进程、不联网、不写盘。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateExecutor } from '../dist/core/executor.js'

const TIMEOUT_DETAIL = '安装超时，已终止子进程'
const NO_TERMINATE_DETAIL = '安装超时；宿主未提供终止能力，这次安装可能仍在后台继续'
const CRASHED_DETAIL = '宿主子进程能力异常，安装未完成'
const TIMEOUT_SETTLED_DETAIL = '安装超时；任务随后退出，安装未完成'
const TERMINATE_FAILED_DETAIL = '安装超时；终止进程失败，这次安装可能仍在后台继续'

const never = () => new Promise(() => {})

const cliParts = (handle, extra = {}) => ({
  environmentKind: 'cli',
  profileDir: 'C:\\fake\\profile',
  runtimeExecutable: 'C:\\fake\\node.exe',
  runtimeExecArgs: [],
  cliEntry: 'C:\\fake\\cli.js',
  subprocess: { spawn: () => handle },
  pluginId: 'my-plugin',
  log: () => {},
  installTimeoutMs: 40,
  ...extra,
})

const cliCall = (runInstall) => runInstall({ version: '1.2.3', profileName: 'web', environmentKind: 'cli' })

const detailOf = async (handle) => {
  let detail = ''
  await assert.rejects(() => cliCall(createUpdateExecutor(cliParts(handle))), (error) => {
    assert.equal(error.code, 'install-failed')
    detail = String(error.detail ?? '')
    return true
  })
  return detail
}

describe('cli 路超时：与普通安装失败分开说（#185 / A 线 R4）', () => {
  it('永不退出、宿主给了 terminate：详情点名超时，并如实说已终止子进程', async () => {
    let terminated = 0
    const handle = {
      done: never(),
      terminate: () => {
        terminated += 1
      },
    }
    const detail = await detailOf(handle)
    assert.equal(detail, TIMEOUT_DETAIL)
    assert.equal(terminated, 1, '有终止能力就要真调一次，且只一次')
    assert.ok(!detail.includes('已请求'), '终止是本包直接调子进程，不许说成「请求宿主」')
    assert.ok(detail.length <= 300)
  })

  it('宿主没给 terminate：不许说「已终止」，要如实说安装可能仍在后台继续', async () => {
    const detail = await detailOf({ done: never() })
    assert.equal(detail, NO_TERMINATE_DETAIL)
    assert.ok(!detail.includes('已终止'))
  })

  it('到点后 terminate 让子进程以非零/空退出码收尾：仍要点名超时，不许退回通用失败', async () => {
    let settleDone
    const done = new Promise((resolve) => {
      settleDone = resolve
    })
    const handle = {
      done,
      terminate: () => settleDone({ exitCode: null }),
    }
    const detail = await detailOf(handle)
    assert.equal(detail, TIMEOUT_DETAIL)
  })

  it('到点后 terminate 让子进程在宽限内以 exitCode 0 收尾：按它自己的结局判成功', async () => {
    let settleDone
    const done = new Promise((resolve) => {
      settleDone = resolve
    })
    const handle = {
      done,
      terminate: () => setTimeout(() => settleDone({ exitCode: 0 }), 0),
    }
    await cliCall(createUpdateExecutor(cliParts(handle)))
  })

  it('done reject 是崩溃不是超时：不许冒充超时', async () => {
    const detail = await detailOf({ done: Promise.reject(new Error('subprocess failed')) })
    assert.equal(detail, CRASHED_DETAIL)
    assert.ok(!detail.includes('安装超时'), `崩溃不能报成超时：${detail}`)
  })

  it('抓取读数里的原文仍在详情前面，超时口径跟着在后面（原文在前、建议在后）', async () => {
    const handle = {
      done: never(),
      terminate: () => {},
      collected: { stdout: { readFrom: () => ({ text: 'ERR_PNPM_SOMETHING 装不上\n' }) } },
    }
    const detail = await detailOf(handle)
    assert.ok(detail.includes('ERR_PNPM_SOMETHING'), `原文必须活着：${detail}`)
    assert.ok(detail.indexOf('ERR_PNPM_SOMETHING') < detail.indexOf('安装超时'), `原文要在前：${detail}`)
    assert.ok(detail.length <= 300, `仍受 300 字封顶：${detail.length}`)
  })

  it('详情接近 300 字时，末尾的凭据说明不被剪半（ADR-0001 决策 2）', async () => {
    const raw = `${'x'.repeat(500)} https://user:secret@mirror.example.com/pkg 拒绝`
    const handle = {
      done: never(),
      terminate: () => {},
      collected: { stdout: { readFrom: () => ({ text: raw }) } },
    }
    const detail = await detailOf(handle)
    assert.ok(detail.includes('账号密码已隐去'), `脱敏说明不许被剪掉：${detail}`)
    assert.ok(detail.endsWith(TIMEOUT_DETAIL), `口径仍在最末尾：${detail}`)
    assert.ok(detail.length <= 300, `仍受 300 字封顶：${detail.length}`)
  })

  it('宿主没给 terminate，但宽限内它自己以非零退出：不许再谎称「可能仍在后台继续」', async () => {
    const handle = {
      done: new Promise((resolve) => setTimeout(() => resolve({ exitCode: 1 }), 80)),
    }
    const detail = await detailOf(handle)
    assert.equal(detail, TIMEOUT_SETTLED_DETAIL)
    assert.ok(!detail.includes('仍在后台'), `进程都退出了，不许说还在后台：${detail}`)
  })

  it('有 terminate 但调用抛错：不许说「已终止」，要如实说终止失败', async () => {
    const handle = {
      done: never(),
      terminate: () => {
        throw new Error('terminate broken')
      },
    }
    const detail = await detailOf(handle)
    assert.equal(detail, TERMINATE_FAILED_DETAIL)
    assert.ok(!detail.includes('已终止'), `终止没成功就不许说已终止：${detail}`)
  })

  it('非零退出（没超时）：保持既有形状，不再添超时口径', async () => {
    const handle = {
      done: Promise.resolve({ exitCode: 1 }),
      collected: { stdout: { readFrom: () => ({ text: 'ERR_PNPM_X 失败\n' }) } },
    }
    const detail = await detailOf(handle)
    assert.ok(detail.includes('ERR_PNPM_X'), detail)
    assert.ok(!detail.includes('安装超时'), `没超时就不许说超时：${detail}`)
  })
})
