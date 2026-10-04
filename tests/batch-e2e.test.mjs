/**
 * tests/batch-e2e.test.mjs —— 多目标真装 e2e（票 #26，只加测试不改 src）。
 *
 * 与 batch-host.test.mjs 的分工：那边多目标用例用假读侧/注入传输，这里全部走**真夹具**：
 *   · 真临时家目录 + 真使用范围目录（mkdtemp），不注入 readQueue/writeQueue ——
 *     queue.json 与 global.lock 都是真落盘；
 *   · 已装环境走真读取器（profileDir/node_modules 下真包，含入口三件，满足 validPackage）；
 *   · 假 registry：fetchImpl 回与真 registry 同形状的 canned JSON；
 *   · 假执行器：真把夹具包版本写盘（入口三件一起写），装完校验才过得去（诚实假件口径）。
 * 断言只看落盘与相位，不看墙钟；超时那条把 installTimeoutMs 调极小，用注入的 now 驱动。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { batchPathsForUpdate, pathsForUpdate, queuePathsForUpdate } from '../dist/store.js'

const REGISTRY = 'https://registry.npmjs.org/'
const ENTRIES = ['index.js', 'client.js', 'patch.js']
const RUNNING_VERSION = '1.0.0'
const TARGET_VERSION = '2.0.0'
/** 超时那条用的极小安装时限：真执行器到点终止子进程并按 install-failed 收（store.ts 口径）。 */
const INSTALL_TIMEOUT_MS = 40

/** 入口文件内容：不用引号嵌引号，避免夹具源码再被转义。 */
function entryBody(name, version, file) {
  return ['use strict', '// e2e fixture ' + name + ' @ ' + version + ' (' + file + ')', ''].join('\n')
}

/** 种一份已装包（含入口三件）：真实布局，读取器认的正是这三个入口。 */
async function plant(profile, name, version) {
  const dir = join(profile, 'node_modules', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      { name, version, main: 'index.js', exports: { './client': './client.js' }, dsh: { bundle: { patch: './patch.js' } } },
      null,
      2,
    ),
  )
  for (const file of ENTRIES) await writeFile(join(dir, file), entryBody(name, version, file))
  return dir
}

/** 真临时使用范围：家目录 + profiles/web + 范围清单（dependencies 决定不是源码安装）。 */
async function makeScope(names) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'batch-e2e-')))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  const dependencies = {}
  for (const name of names) dependencies[name] = '^1.0.0'
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({ name: 'e2e-profile', private: true, dependencies }, null, 2),
  )
  const dirs = {}
  for (const name of names) dirs[name] = await plant(profile, name, RUNNING_VERSION)
  return { home, profile, dirs }
}

/** 诚实执行器唯一承诺的结果：目标版真落盘（入口三件一起写，validPackage 才过）。 */
async function writeVersion(dir, name, version) {
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.version = version
  manifest.main = 'index.js'
  manifest.exports = { './client': './client.js' }
  manifest.dsh = { bundle: { patch: './patch.js' } }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  for (const file of ENTRIES) await writeFile(join(dir, file), entryBody(name, version, file))
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** 等条件成立（异步收尾不靠墙钟断言，只等它落定）。 */
async function waitFor(check, label) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  assert.fail('等待超时：' + label)
}

function specsOf(names) {
  return names.map((name) => {
    const key = name.replace('pkg-', '')
    return { key, title: '夹具 ' + name, packageName: name, prefix: 'p-' + key }
  })
}

function entryOf(session, key) {
  return session.entries.find((entry) => entry.key === key) ?? null
}

function phaseOf(session, key) {
  const entry = entryOf(session, key)
  return entry ? entry.phase : null
}

/**
 * 建批量宿主：逐目标注入真读侧（真磁盘）+ 假 registry + 假执行器；
 * 队列与锁一律不注入（真 queue.json / 真 global.lock）。
 * plan[key] 可给 onFetch / onInstall 采样钩子，以及 runInstall 覆盖（失败 / 不返回）。
 */
function buildBatch(scope, specs, plan = {}, options = {}) {
  const clock = { value: 1000000 }
  const now = () => (clock.value += 1)
  const fetches = []
  const installs = []
  const overridesFor = (spec) => {
    const one = plan[spec.key] ?? {}
    const dir = scope.dirs[spec.packageName]
    return {
      homeDir: scope.home,
      profileDir: scope.profile,
      profileName: 'web',
      environmentKind: 'cli',
      nodeVersion: '22.0.0',
      targetPackageName: spec.packageName,
      targetPackageDir: dir,
      runningVersion: RUNNING_VERSION,
      fetchImpl: async () => {
        fetches.push(spec.key)
        if (one.onFetch) await one.onFetch()
        return {
          ok: true,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              name: spec.packageName,
              version: TARGET_VERSION,
              engines: { node: '>=22' },
              dist: {
                tarball: REGISTRY + spec.packageName + '/-/' + spec.packageName + '-' + TARGET_VERSION + '.tgz',
                integrity: 'sha512-' + 'C'.repeat(86) + '==',
              },
            }),
        }
      },
      now,
      randomId: (() => {
        let n = 0
        return () => 'id-' + (n += 1)
      })(),
      runInstall: async (args) => {
        installs.push(spec.key)
        if (one.runInstall) return await one.runInstall(args)
        if (one.onInstall) await one.onInstall()
        await writeVersion(dir, spec.packageName, args.version)
      },
    }
  }
  const deps = {
    scope: { homeDir: scope.home, profileDir: scope.profile },
    readerOverridesFor: overridesFor,
    now,
    installPollMs: options.installPollMs ?? 5,
  }
  if (options.config) deps.config = options.config
  const host = createMultiHostUpdate(deps, {
    prefix: 'life',
    targets: specs,
    selfKey: options.selfKey ?? null,
  })
  return { host, fetches, installs, clock }
}

describe('多目标真装 e2e（真队列 / 真锁 / 假 registry / 真写盘执行器）', () => {
  it('E1 两目标真装串行：A 收尾后 B 才起步，owner 至多一个、收尾后锁已释放', async () => {
    __resetSharedUpdateReaderForTests()
    const scope = await makeScope(['pkg-a', 'pkg-b'])
    const queueFile = queuePathsForUpdate(scope.home, scope.profile).file
    const lockFile = queuePathsForUpdate(scope.home, scope.profile).lock
    const sessionFile = batchPathsForUpdate(scope.home, scope.profile).file
    const ownerWhileInstalling = []
    let sessionAtBStart = null
    const { host, fetches, installs } = buildBatch(scope, specsOf(['pkg-a', 'pkg-b']), {
      a: {
        onInstall: async () => {
          ownerWhileInstalling.push({ key: 'a', owner: (await readJson(queueFile)).owner })
        },
      },
      b: {
        onFetch: async () => {
          if (!sessionAtBStart) sessionAtBStart = await readJson(sessionFile)
        },
        onInstall: async () => {
          ownerWhileInstalling.push({ key: 'b', owner: (await readJson(queueFile)).owner })
        },
      },
    })
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(fetches, ['a', 'a', 'b', 'b'], 'A 的查+装都收尾了，B 才联网查（真串行）')
    assert.deepEqual(installs, ['a', 'b'], '装也是一家收尾才起下一家')
    assert.equal(phaseOf(reply.session, 'a'), 'done')
    assert.equal(phaseOf(reply.session, 'b'), 'done')
    assert.equal(entryOf(reply.session, 'a').restartRequired, true, '装完要重启才生效（运行版仍 pin 旧版）')
    assert.equal(phaseOf(sessionAtBStart, 'a'), 'done', 'B 开始查时，盘上 A 已经收尾')
    assert.equal(phaseOf(sessionAtBStart, 'b'), 'checking')
    assert.equal(ownerWhileInstalling.length, 2)
    for (const sample of ownerWhileInstalling) {
      assert.ok(sample.owner, '装的时候队列里有 owner');
      assert.equal(sample.owner.pluginId, 'life-' + sample.key, 'owner 就是正在装的那家（任一时刻至多一个）')
    }
    assert.equal((await readJson(queueFile)).owner, null, '收尾后 owner 摘牌')
    assert.equal(existsSync(lockFile), false, '收尾后 global.lock 不存在')
    assert.equal((await readJson(join(scope.dirs['pkg-a'], 'package.json'))).version, TARGET_VERSION, 'A 的目标版真落盘')
    assert.equal((await readJson(join(scope.dirs['pkg-b'], 'package.json'))).version, TARGET_VERSION, 'B 的目标版真落盘')
    host.dispose()
  })

  it('E2 中间一家装失败：后一家照跑，owner 与锁都靠正常收尾释放（不靠陈旧回收）', async () => {
    __resetSharedUpdateReaderForTests()
    const scope = await makeScope(['pkg-a', 'pkg-b', 'pkg-c'])
    const queueFile = queuePathsForUpdate(scope.home, scope.profile).file
    const lockFile = queuePathsForUpdate(scope.home, scope.profile).lock
    let ownerWhileC = null
    let lockWhileC = null
    const { host, installs } = buildBatch(scope, specsOf(['pkg-a', 'pkg-b', 'pkg-c']), {
      b: {
        runInstall: async () => {
          throw new Error('e2e-executor-boom')
        },
      },
      c: {
        onInstall: async () => {
          ownerWhileC = (await readJson(queueFile)).owner
          lockWhileC = existsSync(lockFile)
        },
      },
    })
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(installs, ['a', 'b', 'c'], '三家都走到了执行器（失败那家自己抛）')
    assert.equal(phaseOf(reply.session, 'a'), 'done')
    assert.equal(phaseOf(reply.session, 'b'), 'failed')
    assert.equal(entryOf(reply.session, 'b').error, 'install-failed')
    assert.equal(phaseOf(reply.session, 'c'), 'done', '后一家照跑成功')
    assert.ok(ownerWhileC, 'C 装的时候队列里有 owner')
    assert.equal(ownerWhileC.pluginId, 'life-c', 'owner 已从失败那家换成 C')
    assert.equal(lockWhileC, true, 'C 自己拿着全局锁')
    assert.equal((await readJson(queueFile)).owner, null, '收尾后 owner 为空')
    assert.equal(existsSync(lockFile), false, '收尾后锁已释放');
    assert.equal((await readJson(join(scope.dirs['pkg-c'], 'package.json'))).version, TARGET_VERSION)
    host.dispose()
  })

  it('E3 安装超时后队列可恢复：执行器到 installTimeoutMs 超时 → 记 failed、锁释放、下一家装完', async () => {
    __resetSharedUpdateReaderForTests()
    const scope = await makeScope(['pkg-a', 'pkg-b'])
    const queueFile = queuePathsForUpdate(scope.home, scope.profile).file
    const lockFile = queuePathsForUpdate(scope.home, scope.profile).lock
    const installLockA = pathsForUpdate(scope.home, 'life-a', scope.profile).lock
    let ownerWhileB = null
    const { host, installs } = buildBatch(
      scope,
      specsOf(['pkg-a', 'pkg-b']),
      {
        a: {
          // 诚实模拟真执行器：被装的子进程永不退出，执行器自己到 installTimeoutMs 按超时失败
          // （store.ts 的 awaitOutcome 口径：到点终止并抛 install-failed，不假装装成功）。
          runInstall: () =>
            new Promise((resolve, reject) => {
              setTimeout(() => reject(new Error('e2e-executor-timeout')), INSTALL_TIMEOUT_MS)
            }),
        },
        b: {
          onInstall: async () => {
            ownerWhileB = (await readJson(queueFile)).owner
          },
        },
      },
      { config: { installTimeoutMs: INSTALL_TIMEOUT_MS }, installPollMs: 5 },
    )
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(installs, ['a', 'b'], 'A 超时收场之后 B 才起步')
    assert.equal(phaseOf(reply.session, 'a'), 'failed', '超时按失败收（诚实失败）')
    assert.equal(entryOf(reply.session, 'a').error, 'install-failed')
    assert.equal(phaseOf(reply.session, 'b'), 'done', '下一家拿到锁并装完（没卡在 update-busy）')
    assert.ok(ownerWhileB, 'B 装的时候队列里有 owner')
    assert.equal(ownerWhileB.pluginId, 'life-b', 'A 超时收尾后 owner 已摘牌，换成 B')
    assert.equal((await readJson(queueFile)).owner, null, '收尾后 owner 为空')
    assert.equal(existsSync(lockFile), false, '收尾后 global.lock 已释放')
    assert.equal(existsSync(installLockA), false, 'A 自己的 install.lock 也放掉了')
    assert.equal(
      (await readJson(join(scope.dirs['pkg-a'], 'package.json'))).version,
      RUNNING_VERSION,
      'A 超时没落盘（诚实失败，不假装装上）',
    )
    assert.equal((await readJson(join(scope.dirs['pkg-b'], 'package.json'))).version, TARGET_VERSION, 'B 真装上')
    host.dispose()
  })

  it('E3b 装还在跑时批量超时：下一家先排队（不算失败），那家真收尾后重推即装上', async () => {
    __resetSharedUpdateReaderForTests()
    const scope = await makeScope(['pkg-a', 'pkg-b'])
    const queueFile = queuePathsForUpdate(scope.home, scope.profile).file
    const lockFile = queuePathsForUpdate(scope.home, scope.profile).lock
    let unblockA = null
    const blockedA = new Promise((resolve) => {
      unblockA = resolve
    })
    const { host, installs } = buildBatch(
      scope,
      specsOf(['pkg-a', 'pkg-b']),
      {
        a: {
          // 执行器永不返回（真卡死）：宿主没有取消在跑安装的路，锁与 owner 都还在它手里。
          runInstall: async (args) => {
            await blockedA
            await writeVersion(scope.dirs['pkg-a'], 'pkg-a', args.version)
          },
        },
      },
      { config: { installTimeoutMs: 4 }, installPollMs: 10 },
    )
    const first = await host.handlers['life.batchInstall']({})
    assert.equal(first.ok, true)
    assert.deepEqual(installs, ['a'], 'A 卡住时 B 不再往下走')
    assert.equal(phaseOf(first.session, 'a'), 'failed', '批量超时按失败收（诚实失败）')
    assert.equal(entryOf(first.session, 'a').error, 'install-failed')
    assert.equal(phaseOf(first.session, 'b'), 'ready', 'B 排上队：不是 failed，远端版本留着')
    assert.equal(entryOf(first.session, 'b').error, null)
    assert.equal(host.lastRun.stoppedBecause, 'queued', '驱动器停在排队处，不继续推')
    assert.equal((await readJson(queueFile)).owner.pluginId, 'life-a', 'owner 仍在卡住那家手里')
    assert.equal(existsSync(lockFile), true, '全局锁也还在它手里（15 分钟陈旧窗口远未到）')

    // 卡住那家真收尾（解除阻塞）→ 正常释放；再推 B 就装上
    unblockA()
    await waitFor(async () => (await readJson(queueFile)).owner === null, 'A 收尾并摘牌')
    const second = await host.handlers['life.batchInstall']({ keys: ['b'] })
    assert.equal(second.ok, true)
    assert.deepEqual(installs, ['a', 'b'])
    assert.equal(phaseOf(second.session, 'b'), 'done', '解除阻塞后 B 立刻能装上')
    assert.equal(phaseOf(second.session, 'a'), 'failed', '账本仍记那次超时（不因它后来装完就改写）')
    assert.equal(
      (await readJson(join(scope.dirs['pkg-a'], 'package.json'))).version,
      TARGET_VERSION,
      '那次装后来真的落盘了：批量超时取消不了在跑的安装，这条限制在这里留证',
    )
    assert.equal((await readJson(queueFile)).owner, null)
    assert.equal(existsSync(lockFile), false)
    host.dispose()
  })
})
