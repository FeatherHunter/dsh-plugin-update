/**
 * tests/issue-196-self-copy.test.mjs —— #196 部署偏斜：更新器「我是哪一份副本」的自检与可见性。
 *
 * 验收对应（票面）：
 *   ① 真机任意宿主插件面板 / 诊断能看到「我这块用的是哪个版本的更新器」（版本 + 副本层级）；
 *   ② 嵌套副本（声明范围被钉死在旧 minor 的消费方）给出可执行的升级指引；
 *   ③ 发布侧治理行（README / docs/maintainers.md）由文档门禁之外的评审检查，不在此测。
 *
 * 只测外部行为：
 *   - selfCopyLevelOf 纯判据；selfCopyInfo 从模块地址反查包根（真实 dist / 临时假副本两种形态）；
 *   - 宿主 includeEnv 回包新增两格（updaterVersion / updaterCopyLevel）；
 *   - 诊断复制（健康态 / 失败态）带「更新器=版本（层级）」；
 *   - 面板页脚恒显更新器身份；嵌套副本在 05 章给可执行的重装命令。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createHostUpdate } from '../dist/host.js'
import { renderUpdatePanelHTML } from '../dist/panel.js'
import { buildHealthyDiagCopy, buildUpdateDiagCopy } from '../dist/panel-copy.js'
import { selfCopyInfo, selfCopyLevelOf } from '../dist/shared/self.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version

const tmpRoots = []

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-196-'))
  tmpRoots.push(dir)
  return dir
}

/** 造一份「假安装副本」：<root>/node_modules[dsh-plugin-update 或 consumer/...] + package.json + dist/self.js。 */
function makeCopy(root, version) {
  const pkg = join(root, 'node_modules', 'dsh-plugin-update')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-plugin-update', version }))
  writeFileSync(join(pkg, 'dist', 'self.js'), '// fake copy\n')
  return pathToFileURL(join(pkg, 'dist', 'self.js')).href
}

function makeNestedCopy(root, version) {
  const consumer = join(root, 'node_modules', 'demo-consumer')
  mkdirSync(consumer, { recursive: true })
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'demo-consumer', version: '1.0.0' }))
  return makeCopy(consumer, version)
}

describe('selfCopyLevelOf：副本层级只看路径里的 node_modules 段数', () => {
  it('使用范围级 / 嵌套 / 开发仓库 / 未知 四态', () => {
    assert.equal(selfCopyLevelOf('D:/p/node_modules/dsh-plugin-update'), 'profile')
    assert.equal(selfCopyLevelOf('/home/u/.dsh/profiles/desktop/node_modules/dsh-plugin-update'), 'profile')
    assert.equal(selfCopyLevelOf('D:/p/node_modules/demo-consumer/node_modules/dsh-plugin-update'), 'nested')
    assert.equal(selfCopyLevelOf('D:/dev/dsh-plugin-update'), 'repo')
    assert.equal(selfCopyLevelOf(''), 'unknown')
    assert.equal(selfCopyLevelOf(null), 'unknown')
  })
})

describe('selfCopyInfo：按模块地址（import.meta.url 口径）反查这一份副本', () => {
  it('真实 dist：版本等于本包 package.json，层级为开发仓库', async () => {
    const info = await selfCopyInfo(pathToFileURL(join(PKG_DIR, 'dist', 'host.js')).href)
    assert.equal(info.version, PKG_VERSION)
    assert.equal(info.level, 'repo')
    // 包根 = 本测试所在仓库根；按解析后的路径对账，不按目录名（干净发版 worktree 的目录名不叫 dsh-plugin-update）。
    assert.ok(info.directory, '应反查到包根')
    assert.equal(realpathSync(info.directory ?? '').toLowerCase(), realpathSync(PKG_DIR).toLowerCase())
  })

  it('临时使用范围级副本：读到该副本自己的版本（部署偏斜下各副本版本不同）', async () => {
    const root = tempRoot()
    const info = await selfCopyInfo(makeCopy(root, '0.13.0'))
    assert.equal(info.version, '0.13.0')
    assert.equal(info.level, 'profile')
  })

  it('临时嵌套副本：层级判为 nested（消费方 node_modules 里的那一份）', async () => {
    const root = tempRoot()
    const info = await selfCopyInfo(makeNestedCopy(root, '0.18.2'))
    assert.equal(info.version, '0.18.2')
    assert.equal(info.level, 'nested')
  })

  it('反查不到包（坏地址 / 没有 package.json）⇒ 未知，不猜版本', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'node_modules', 'dsh-plugin-update', 'dist'), { recursive: true })
    const info = await selfCopyInfo(pathToFileURL(join(root, 'node_modules', 'dsh-plugin-update', 'dist', 'self.js')).href)
    assert.equal(info.version, null)
    assert.equal(info.level, 'unknown')
    const broken = await selfCopyInfo('file:///D:/nope/nowhere/dist/self.js')
    assert.equal(broken.version, null)
    assert.equal(broken.level, 'unknown')
  })
})

describe('诊断复制：健康态与失败态都带「更新器=版本（层级）」', () => {
  const healthy = {
    canInstall: false,
    latestVersion: '0.18.16',
    installed: true,
    runningVersion: '0.18.16',
    installedVersion: '0.18.16',
    queuePosition: null,
    pluginId: 'demo-plugin',
    hostKind: 'desktop-manager',
    profileName: 'desktop',
    requestId: null,
    checkId: null,
  }

  it('健康态：有自检事实即带一行，没有就不编', () => {
    const withSelf = buildHealthyDiagCopy({ ...healthy, updater: { version: '0.13.0', level: 'nested' } })
    assert.ok(withSelf.includes('更新器=0.13.0（nested）'), withSelf)
    const without = buildHealthyDiagCopy(healthy)
    assert.ok(!without.includes('更新器='), '调用方没给自检事实时不得凭空编更新器版本')
  })

  it('失败态：来源行带一行，且缺省省略', () => {
    const failed = {
      pluginId: 'demo-plugin',
      code: 'install-failed',
      detail: 'already-installed',
      hostKind: 'desktop-manager',
      profileName: 'desktop',
      updater: { version: '0.13.0', level: 'nested' },
    }
    const copy = buildUpdateDiagCopy(failed)
    assert.ok(copy.includes('更新器=0.13.0（nested）'), copy)
    const without = buildUpdateDiagCopy({ ...failed, updater: undefined })
    assert.ok(!without.includes('更新器='), '没有自检事实时不得多出字段（老调用形状不变）')
  })
})

describe('宿主 includeEnv：回包多两格自检事实（不给路径）', () => {
  function makeHost() {
    return createHostUpdate(
      {
        readerOverrides: {
          runningVersion: '1.0.0',
          profileDir: 'C:\\fake\\profile',
          profileName: 'web',
          homeDir: 'C:\\fake\\home',
          fetchImpl: async () => ({
            ok: true,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                name: 'demo-plugin',
                version: '2.0.0',
                dist: { tarball: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-2.0.0.tgz', integrity: 'sha512-x' },
              }),
          }),
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
          readJob: async () => null,
          writeJob: async () => {},
          tryAcquireLock: async () => true,
          releaseLock: async () => {},
          backupJob: async () => {},
          runInstall: async () => {},
        },
      },
      { pluginId: 'demo-plugin', prefix: 'demo' },
    )
  }

  it('env 带 updaterVersion / updaterCopyLevel，且不带本机路径', async () => {
    const host = makeHost()
    const out = await host.handlers['demo.updateStatus']({ includeEnv: true })
    assert.equal(out.ok, true)
    assert.equal(out.env.updaterVersion, PKG_VERSION)
    assert.equal(out.env.updaterCopyLevel, 'repo')
    assert.ok(!JSON.stringify(out.env).includes('C:'), '自检事实只给版本与层级，不给路径')
  })
})

describe('面板：页脚恒显更新器身份；嵌套副本在 05 章给可执行命令', () => {
  function inputFor(overrides = {}) {
    return {
      snapshot: {
        runningVersion: '1.0.0',
        installedVersion: '1.0.0',
        latestVersion: '1.1.0',
        canInstall: true,
        blockedReason: null,
        job: null,
      },
      manual: null,
      queue: { busy: false, owner: null, waiting: [], position: null },
      skippedLatest: false,
      lastError: null,
      showOthers: false,
      pluginId: 'demo-plugin',
      copyNotice: null,
      mode: 'dialog',
      profileName: 'desktop',
      ...overrides,
    }
  }

  it('页脚（dialog）带 dsh-plugin-update@版本 (层级)，ASCII 身份不翻译', () => {
    const html = renderUpdatePanelHTML(inputFor({ updater: { version: '0.13.0', level: 'nested' } }))
    assert.ok(html.includes('dsh-plugin-update@0.13.0 (nested)'), '页脚要能看到这块面板跑的是哪一份副本')
  })

  it('嵌套副本：05 章给出「先更新所属插件 / 或载体 CLI」的可执行指引', () => {
    const html = renderUpdatePanelHTML(inputFor({ updater: { version: '0.13.0', level: 'nested' } }))
    assert.ok(html.includes('dsh plugin --profile desktop add --save-exact dsh-plugin-update@latest'), html)
    assert.ok(html.includes('嵌套副本'), '要说清为什么升级不生效')
    assert.ok(html.includes('请先更新那个插件'), '要先说清唯一真正能修好本面板副本的那一步')
    assert.ok(html.includes('让共用那一份的其他插件先拿到修复'), 'CLI 一步只帮共用使用范围级副本的其他插件，不能冒充本面板的修复')
  })

  it('嵌套副本但不知道使用范围名：不画「或运行：」空命令，只说明升级路径', () => {
    const html = renderUpdatePanelHTML(inputFor({ profileName: null, updater: { version: '0.13.0', level: 'nested' } }))
    assert.ok(html.includes('嵌套副本'), '仍要说清为什么升级不生效')
    assert.ok(!html.includes('dsh plugin --profile'), '没有范围名就不能编命令（假命令比没有更糟）')
    assert.ok(!/或载体 CLI[^<]*$/.test(html), '不得留下指向空命令的半句话')
  })

  it('使用范围级副本：不冒充嵌套，不画升级指引', () => {
    const html = renderUpdatePanelHTML(inputFor({ updater: { version: '0.18.16', level: 'profile' } }))
    assert.ok(html.includes('dsh-plugin-update@0.18.16 (profile)'))
    assert.ok(!html.includes('dsh plugin --profile desktop add --save-exact dsh-plugin-update@latest'))
  })

  it('没有 footer 的形态（embedded）由 05 章兜底显示身份', () => {
    const html = renderUpdatePanelHTML(inputFor({ mode: 'embedded', updater: { version: '0.18.16', level: 'repo' } }))
    assert.ok(html.includes('dsh-upd-updater-id'), 'embedded 面板也要能看到本面板跑的是哪一份副本')
    assert.ok(html.includes('dsh-plugin-update@0.18.16 (repo)'))
    assert.ok(!html.includes('class="dsh-upd-updater-note"'), 'embedded 不画 dialog 专属的 footer 身份')
  })
})

// 末尾统一清理临时目录（node:test 进程结束时也会清，这里显式保证失败用例也不留垃圾）。
process.on('exit', () => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})
