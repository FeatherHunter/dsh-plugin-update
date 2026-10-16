/**
 * tests/issue-153-dev-source.test.mjs —— #153：开发态挂载（junction/源码链接）不再报 unknown-profile。
 *
 * 只测外部行为：电话层、文案层、手工命令层、面板层。不测内部函数名。
 * - 开发态目录（包真实存在、但不在 <范围>/node_modules/<包> 下）+ 没给 profileDir
 *   → 电话回 dev-source（不是 unknown-profile）；
 * - 真定位不到（包不存在）→ 仍是 unknown-profile（旧行为不动）；
 * - dev-source 有中文文案、不给手工命令、面板认识它；
 * - 无快照 + 失败锁存（failed 横幅）时复制诊断按钮仍在（B 修）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 'demo-dev-source-pkg'
const VERSION = '1.2.3'

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

/** 开发态包目录：真实存在、版本合法，但不在任何 <范围>/node_modules/<包> 下（junction 实装同构）。 */
function makeDevSourceDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dpu-devsrc-'))
  writeJson(join(dir, 'package.json'), { name: TARGET, version: VERSION })
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  return dir
}

async function freshHost() {
  const mod = await import(pathToFileURL(join(PKG_DIR, 'dist', 'host.js')).href + '?x=' + Date.now() + Math.random())
  mod.__resetSharedUpdateReaderForTests()
  return mod
}

function baseOverrides(extra = {}) {
  return {
    readerOverrides: {
      profileName: 'web',
      homeDir: mkdtempSync(join(tmpdir(), 'dpu-devsrc-home-')),
      environmentKind: 'cli',
      targetPackageName: TARGET,
      fetchImpl: async () => { throw new Error('no-net') },
      now: () => 1_000_000,
      randomId: () => 'id-1',
      nodeVersion: '22.0.0',
      ...extra,
    },
  }
}

test('#153-A 开发态挂载：包在但不在版本位置 → dev-source，不是 unknown-profile', async () => {
  const host = await freshHost()
  const devDir = makeDevSourceDir()
  const update = host.createHostUpdate(
    baseOverrides({ targetPackageDir: devDir }),
    { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: TARGET },
  )
  const out = await update.handlers['repro.updateStatus']({})
  assert.equal(out.ok, false, '开发态应诚实失败')
  assert.equal(out.error, 'dev-source', '开发态挂载必须报 dev-source')
  assert.equal(out.errorKind, 'dev-source')
})

test('#153-A 守住：包真不存在 → 仍是 unknown-profile（旧行为不动）', async () => {
  const host = await freshHost()
  const update = host.createHostUpdate(
    baseOverrides({}),
    { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: 'nonexistent-pkg-xyz-153' },
  )
  const out = await update.handlers['repro.updateStatus']({})
  assert.equal(out.ok, false)
  assert.equal(out.error, 'unknown-profile')
})

test('#153-A 文案层：dev-source 有中文、不给手工命令、面板认识', async () => {
  const panel = await import(pathToFileURL(join(PKG_DIR, 'dist', 'panel.js')).href + '?x=' + Date.now() + Math.random())
  const cmds = await import(pathToFileURL(join(PKG_DIR, 'dist', 'commands.js')).href + '?x=' + Date.now() + Math.random())
  const copy = panel.blockedCopy('dev-source')
  assert.ok(copy && copy.title && copy.action, 'dev-source 必须有标题与行动句')
  assert.match(copy.title + copy.action, /[\u4e00-\u9fff]/, '必须含中文')
  assert.ok(panel.isKnownFailureCode('dev-source'), 'dev-source 应计入稳定码')
  const f = panel.failureCopy('dev-source')
  assert.ok(f && f.zh && f.act, 'failureCopy 必须认识 dev-source')
  assert.equal(f.zh, copy.title, '阻塞行复用同一原文，不另起措辞')
  const manual = cmds.manualCommand({
    profileName: 'web', latestVersion: '1.2.4', installedVersion: VERSION,
    runningVersion: VERSION, jobTargetVersion: null, blockedReason: 'dev-source',
    sourceInstall: false,
  })
  assert.equal(manual, null, '开发态不给手工命令（与源码安装同口径）')
})

test('#153-B 无快照 + 失败时复制诊断按钮仍在（锁存/失败横幅）', async () => {
  const panel = await import(pathToFileURL(join(PKG_DIR, 'dist', 'panel.js')).href + '?x=' + Date.now() + Math.random())
  const view = panel.panelViewModel({ snapshot: null, manual: null, queue: null, skippedLatest: false, lastError: 'dev-source' })
  assert.equal(view.banner.kind, 'failed', '无快照有错应为 failed 横幅')
  const html = panel.renderUpdatePanelKernel(
    {
      snapshot: null, manual: null, queue: null, skippedLatest: false, lastError: 'dev-source',
      mode: 'embedded', showOthers: false, pluginId: 'p', copyNotice: null,
    },
    view,
  )
  assert.match(html, /data-action="copy-diag"/, '失败时复制诊断必须可点（无快照也不隐藏）')
})

test('#153 对抗：显式目录指错（包不存在）+ 版本覆盖 → 仍是 unknown-profile，不许谎称 dev-source', async () => {
  const host = await freshHost()
  const update = host.createHostUpdate(
    baseOverrides({
      runningVersion: VERSION,
      targetPackageDir: join(mkdtempSync(join(tmpdir(), 'dpu-devsrc-bogus-')), 'no-such-dir'),
    }),
    { pluginId: 'repro-plugin', prefix: 'repro', targetPackageName: TARGET },
  )
  const out = await update.handlers['repro.updateStatus']({})
  assert.equal(out.ok, false)
  assert.equal(out.error, 'unknown-profile', '指的地方没这个包，真相是认不出，不是开发态')
})

test('#153 对抗：首帧 loading（无快照、无失败）→ 不多复制诊断按钮', async () => {
  const panel = await import(pathToFileURL(join(PKG_DIR, 'dist', 'panel.js')).href + '?x=' + Date.now() + Math.random())
  const view = panel.panelViewModel({ snapshot: null, manual: null, queue: null, skippedLatest: false, lastError: null })
  assert.equal(view.banner.kind, 'loading')
  const html = panel.renderUpdatePanelKernel(
    {
      snapshot: null, manual: null, queue: null, skippedLatest: false, lastError: null,
      mode: 'embedded', showOthers: false, pluginId: 'p', copyNotice: null,
    },
    view,
  )
  assert.doesNotMatch(html, /data-action="copy-diag"/, '无证据时不许多一个按钮')
})

test('#153-A 读者层：junction 实装（node_modules 下是链接，实址在范围外）→ dev-source', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dpu-devsrc-prof-'))
  const outside = makeDevSourceDir()
  writeJson(join(profileDir, 'package.json'), { name: 'fake-profile', version: '0.0.0', dependencies: { [TARGET]: `^${VERSION}` } })
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  try {
    symlinkSync(outside, join(profileDir, 'node_modules', TARGET), 'junction')
  } catch (e) {
    console.log('#153 reader-junction skipped here (no symlink privilege): ' + e.code)
    return
  }
  const { createUpdateReader } = await import(
    pathToFileURL(join(PKG_DIR, 'dist', 'reader.js')).href + '?x=' + Date.now() + Math.random()
  )
  const reader = createUpdateReader({
    runningVersion: VERSION,
    profileDir,
    pluginId: 'repro-plugin',
    profileName: 'web',
    homeDir: profileDir,
    targetPackageName: TARGET,
    fetchImpl: async () => { throw new Error('no-net') },
    now: () => 1_000_000,
    randomId: () => 'id-1',
    nodeVersion: '22.0.0',
    environmentKind: 'cli',
  })
  const env = await reader.readEnv()
  assert.equal(env.installedVersion, VERSION, 'junction 包版本应照读')
  assert.equal(env.blockedReason, 'dev-source', '实址在范围外必须是 dev-source')
})
