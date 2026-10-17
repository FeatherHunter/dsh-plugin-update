/**
 * tests/issue-154-install-diag.test.mjs —— #154：安装失败诊断两处顺手修。
 *
 * 1. 原因行前置：install-failed 的工具输出通常头重脚轻（进度头 + 中部真因 + 尾部噪音），
 *    而预算截断只保头。pickDetail 把失败标记行提到最前面（只重排，不增删一字）。
 * 2. 未知源文案：无 registryHost 的诊断复制文本写「源=未声明」，不再是绕口的旧文案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

async function freshHost() {
  const mod = await import(pathToFileURL(join(PKG_DIR, 'dist', 'host.js')).href + '?x=' + Date.now() + Math.random())
  return mod
}

async function freshPanel() {
  const mod = await import(pathToFileURL(join(PKG_DIR, 'dist', 'panel.js')).href + '?x=' + Date.now() + Math.random())
  return mod
}

// 现场 pnpm 输出同构（行序一致、远超 300 字；包名版本保留，无秘密）：
// 进度头 + 中部真因（✗/ERR_/缩进续行）+ 尾部噪音。
const PNPM_LONG = [
  '? Verifying lockfile against supply-chain policies (309 entries)...',
  'Progress: resolved 1, reused 0, downloaded 0, added 0',
  'Progress: resolved 10, reused 1, downloaded 0, added 0',
  'Progress: resolved 52, reused 1, downloaded 0, added 0',
  '✗ Lockfile failed supply-chain policy check (309 entries in 2.8s)',
  '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:',
  '  dshmarket@1.66.28 was published at 2026-10-16T05:58:34.000Z, within the minimumReleaseAge cutoff (2026-10-15T07:34:55.413Z)',
  'The lockfile contains entries that the active policies reject. If the changes look expected, rebuild from a fresh resolution.',
  'Progress: resolved 132, reused 1, downloaded 0, added 0',
  '[WARN] GET https://registry.example.invalid/chromium-bidi error (UND_ERR_DESTROYED). Will retry in 10 seconds. 2 retries left.',
].join('\n')

test('#154-1 install-failed 长输出：真因行提到摘要最前面，300 字内见得到码与包名', async () => {
  const host = await freshHost()
  const diag = host.buildDiag({
    errorCode: 'install-failed',
    phoneKind: 'update-install',
    error: { detail: PNPM_LONG },
  })
  assert.ok(diag && typeof diag === 'object', '应产出 diag')
  assert.ok(diag.detail.startsWith('✗ Lockfile failed'), '首行即 ✗ 行，实际=' + String(diag.detail).slice(0, 60))
  assert.ok(diag.detail.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'), '300 字内见得到 ERR 码')
  assert.ok(diag.detail.includes('dshmarket@1.66.28'), '缩进续行跟随原因行，包名不丢')
  assert.ok(!diag.detail.slice(0, 60).includes('Verifying'), '进度头被请到后面')
})

test('#154-2 守住：非 install-failed 同样文本不重排', async () => {
  const host = await freshHost()
  const diag = host.buildDiag({
    errorCode: 'check-failed',
    phoneKind: 'update-status',
    error: { detail: PNPM_LONG },
  })
  assert.ok(diag && typeof diag === 'object', '应产出 diag')
  assert.ok(diag.detail.startsWith('? Verifying'), '顺序与原来一致，实际=' + String(diag.detail).slice(0, 40))
})

test('#154-3 守住：install-failed 无原因行不重排', async () => {
  const host = await freshHost()
  const diag = host.buildDiag({
    errorCode: 'install-failed',
    phoneKind: 'update-install',
    error: { detail: 'line one\nline two' },
  })
  assert.ok(diag && typeof diag === 'object', '应产出 diag')
  const i1 = diag.detail.indexOf('line one')
  const i2 = diag.detail.indexOf('line two')
  assert.ok(i1 !== -1 && i2 !== -1 && i1 < i2, '两行都在且顺序不变')
})

test('#154-5 宿主码前缀不污染前置：operation-error: 进度头不算原因行，✗ 行仍置顶', async () => {
  const host = await freshHost()
  // 2026-10-17 dsh-prompt 0.4.28→0.4.29 现场：store.ts detailText 把宿主 ManagementError
  // 收成 `operation-error: <原话首行>`，前缀自身含 error 一词，旧判定把进度头误判成原因行。
  const detail = [
    'operation-error: ? Verifying lockfile against supply-chain policies (310 entries)...',
    'dsh-im-companion is linked to C:\\x from C:\\y',
    'Progress: resolved 1, reused 0, downloaded 0, added 0',
    '✗ Lockfile failed supply-chain policy check (310 entries in 966ms)',
  ].join('\n')
  const diag = host.buildDiag({
    errorCode: 'install-failed',
    phoneKind: 'update-install',
    error: { detail },
  })
  assert.ok(diag && typeof diag === 'object', '应产出 diag')
  assert.ok(diag.detail.startsWith('✗ Lockfile failed'), '首行即 ✗ 行，实际=' + String(diag.detail).slice(0, 60))
  assert.ok(diag.detail.includes('operation-error:'), '宿主码前缀原样保留，只是换位，不删一字')
})

test('#154-6 守住：ERR_ 机器前缀本身即信号，不剥离', async () => {
  const host = await freshHost()
  const detail = [
    '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:',
    'progress line neutral',
    '✗ Lockfile failed supply-chain policy check (309 entries in 2.8s)',
  ].join('\n')
  const diag = host.buildDiag({
    errorCode: 'install-failed',
    phoneKind: 'update-install',
    error: { detail },
  })
  assert.ok(diag && typeof diag === 'object', '应产出 diag')
  assert.ok(String(diag.detail).includes('ERR_PNPM_MINIMUM_RELEASE_AGE'), '机器码不丢')
})
test('#154-4 未知源文案：无 registryHost 写 源=未声明', async () => {
  const panel = await freshPanel()
  const text = panel.buildUpdateDiagCopy({
    pluginId: 'my-plugin',
    code: 'install-failed',
    detail: 'some failure',
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    hostKind: 'cli',
    queuePosition: null,
  })
  assert.ok(text.includes('源=未声明'), '应写未声明，实际=' + text.slice(0, 400))
  assert.ok(!text.includes('源=未知'), '不再出现旧的未知源文案（使用范围=未知不受影响）')
})
