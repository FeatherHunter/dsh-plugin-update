/**
 * tests/issue-184-timeout-honesty.test.mjs —— 超时语义诚实化（#184，S1，A 线 R5）。
 *
 * 只钉票面**新增的两条**行为（有取消能力时口径不变、移除后不许重装，已由
 * `tests/desktop-manager-hmr.test.mjs:342-359`、`:361-373` 钉着，不在这里重复）：
 * 1. 宿主**没有** `cancelInstall` 能力时，安装步超时的人话格（detail）不许写「已请求宿主取消」——
 *    我们一次都没请求过（审查探针：`cancelCalls: 0, claimsCancelAsked: true`），要如实说
 *    「宿主未提供取消能力」，并提示这次安装可能仍在后台继续（用户被告知失败、实际却装上了）。
 * 2. 移除步超时：移除请求可能已经生效——目标包可能已不在册、也没有重装。人话格必须把这层
 *    事实与下一步写出来（重启宿主检查 + 按手工命令重装），不能只说「未继续安装」。
 * 3. 验收后半句：移除超时后环境读取得出「已摘选中」（#180 的 `registered === false`，磁盘还在），
 *    面板据此可识别「包被摘下但没重装」，不再以为包还在。
 *
 * 只从公开入口进：`dist/store.js` 的 `createUpdateExecutor` 与 `dist/reader.js` 的
 * `createUpdateReader`；管理器、计时全用假件，不碰真机、不起进程、不联网。
 * 先红后绿：未修树两条全红（谎称已请求取消 / 不点明包可能已不在册）。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createUpdateExecutor, __executorInternals } from '../dist/store.js'
import { createUpdateReader } from '../dist/reader.js'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'

const TARGET = 'dsh-mattpocock-skills-deck'
const INSTALLED = '1.2.2'
const MANAGER_KIND = 'desktop-manager'
const REGISTRY = 'https://registry.npmjs.org/'

/** 首装超时那条既有冻结中文（有取消能力时口径不变；本文件只拿它当「不许出现」的反例）。 */
const INSTALL_TIMEOUT_DETAIL = '安装超时，已请求宿主取消'
/** 终止宽限期：既有常量（超时后宿主还会等它自己收尾这么久）。 */
const GRACE_MS = __executorInternals.TERMINATION_GRACE_MS

const alreadyInstalled = () => ({ application: 'failed', error: { code: 'already-installed' } })

const tmpRoots = []

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

function readProfile(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

/** 造一个「盘上已装、清单在册」的使用范围（deps + dsh.profile.bundles 都登记）。 */
function makeProfile() {
  const root = mkdtempSync(join(tmpdir(), 'dpu-184-'))
  tmpRoots.push(root)
  const profileDir = join(root, 'profiles', 'desktop')
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    version: '0.0.0',
    dependencies: { [TARGET]: INSTALLED },
    dsh: { profile: { bundles: [TARGET] } },
  })
  writeJson(join(profileDir, 'node_modules', TARGET, 'package.json'), {
    name: TARGET,
    version: INSTALLED,
    main: './index.js',
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './patch.js' } },
  })
  writeFileSync(join(profileDir, 'node_modules', TARGET, 'index.js'), 'module.exports = {}\n')
  writeFileSync(join(profileDir, 'node_modules', TARGET, 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(profileDir, 'node_modules', TARGET, 'patch.js'), 'module.exports = {}\n')
  return { root, profileDir }
}

/** 读环境（直读读取器）：只关心 #180 的「在册」事实。 */
function readerFor(profileDir) {
  return createUpdateReader({
    runningVersion: INSTALLED,
    profileDir,
    pluginId: 'issue-184-plugin',
    profileName: 'desktop',
    homeDir: profileDir,
    osHome: profileDir,
    env: {},
    fetchImpl: async () => {
      throw new Error('本测试不联网')
    },
    targetPackageDir: join(profileDir, 'node_modules', TARGET),
    targetPackageName: TARGET,
    environmentKind: MANAGER_KIND,
    registryUrl: REGISTRY,
  })
}

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
  }
}

/** 宿主公开入口：面板只拿 includeEnv 回来的环境视图（#184 起该视图带 registered）。 */
function makeHost(profileDir) {
  return createHostUpdate(
    {
      logCtx: { fire: () => {} },
      readerOverrides: {
        runningVersion: INSTALLED,
        targetPackageDir: join(profileDir, 'node_modules', TARGET),
        profileDir,
        profileName: 'desktop',
        homeDir: profileDir,
        fetchImpl: async () => {
          throw new Error('本测试不联网')
        },
        now: () => 1_000_000,
        randomId: () => 'id-184',
        nodeVersion: '22.0.0',
        environmentKind: MANAGER_KIND,
        targetPackageName: TARGET,
        ...memoryStore(),
      },
    },
    { pluginId: 'issue-184-plugin', prefix: 'issue184', targetPackageName: TARGET }
  )
}

/** 给一次调用套上硬上限：到点还没收场就往回交 hang，免得挂死的实现把测试吊住。 */
async function cappedSettle(run, capMs) {
  const HANG = Symbol('hang')
  let timer = null
  try {
    const outcome = await Promise.race([
      run().then(
        () => ({ kind: 'resolved' }),
        (error) => ({ kind: 'failed', error })
      ),
      new Promise((settle) => {
        timer = setTimeout(() => settle(HANG), capMs)
      }),
    ])
    return outcome === HANG ? { kind: 'hang' } : outcome
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

const runWith = (parts) =>
  createUpdateExecutor({
    environmentKind: MANAGER_KIND,
    profileName: 'desktop',
    pluginId: 'issue-184-plugin',
    targetPackageName: TARGET,
    ...parts,
  })
const call = (runInstall, version = '1.2.3') =>
  runInstall({ version, profileName: 'desktop', environmentKind: MANAGER_KIND })

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('issue #184：超时语义诚实化（不谎称已取消；移除超时点明包可能已不在册）', () => {
  it('宿主没有 cancelInstall：安装步超时人话格如实说「未提供取消能力」，不谎称已请求取消', async () => {
    const manager = { installBundle: () => new Promise(() => {}) }
    const outcome = await cappedSettle(
      () => call(runWith({ installTimeoutMs: 30, pluginManager: manager, log: () => {} })),
      30 + GRACE_MS + 4000
    )
    assert.equal(outcome.kind, 'failed', '安装挂死必须收场')
    assert.equal(outcome.error.code, 'install-failed')
    const detail = String(outcome.error.detail)
    assert.ok(!detail.includes('已请求宿主取消'), `没有取消能力却声称已请求取消：${detail}`)
    assert.notEqual(detail, INSTALL_TIMEOUT_DETAIL, '无取消能力时不许复用「有取消能力」那条冻结中文')
    assert.match(detail, /未提供取消能力/, `人话格要点明宿主没有取消能力：${detail}`)
    assert.match(detail, /可能仍在后台继续/, `人话格要提示这次安装可能仍在跑：${detail}`)
  })

  it('移除步超时：人话格点明「目标包可能已不在册」并给「重启宿主 + 手工命令」的下一步', async () => {
    const { profileDir } = makeProfile()
    const manager = {
      installBundle: () => Promise.resolve(alreadyInstalled()),
      removeBundle() {
        // 移除请求真的生效了（宿主侧先改盘再回话是常态），但回话拖过了额度与宽限期。
        const manifest = readProfile(profileDir)
        delete manifest.dependencies[TARGET]
        manifest.dsh = { profile: { ...(manifest.dsh?.profile ?? {}), bundles: [] } }
        writeJson(join(profileDir, 'package.json'), manifest)
        return new Promise(() => {})
      },
    }
    const outcome = await cappedSettle(
      () => call(runWith({ installTimeoutMs: 30, pluginManager: manager, log: () => {} })),
      30 + GRACE_MS + 4000
    )
    assert.equal(outcome.kind, 'failed', '移除挂死必须收场')
    assert.equal(outcome.error.code, 'install-failed')
    const detail = String(outcome.error.detail)
    assert.match(detail, /移除/, `人话格要看出卡在移除这一步：${detail}`)
    assert.notEqual(detail, INSTALL_TIMEOUT_DETAIL, '移除步超时的人话格必须与首装超时那条不同')
    assert.match(detail, /目标包可能已不在册/, `人话格要点明包可能已被摘掉：${detail}`)
    assert.match(detail, /手工命令/, `人话格要给出下一步（手工命令）：${detail}`)
    assert.match(detail, /重启宿主/, `人话格要给出下一步（重启宿主检查）：${detail}`)
    // 面板在这类状态里可能给不出手工命令（目标已不在 dependencies ⇒ 读取器判源码安装）：
    // 人话格里必须带一条一定能用的桌面 CLI 重装命令（包名@目标版本）。
    assert.match(detail, /dsh plugin --profile desktop add --save-exact/, `人话格要带可执行的重装命令：${detail}`)
    assert.ok(detail.includes(`${TARGET}@1.2.3`), `重装命令要带目标包与目标版本：${detail}`)

    // 票面验收后半句：环境读取得出「已摘选中」（面板据此识别「被摘但没重装」）。
    const env = await readerFor(profileDir).readEnv()
    assert.equal(env.installed, true, '包还在磁盘上（移除只摘了在册/登记）')
    assert.equal(env.registered, false, '清单里已经没有这个包：registered 必须是 false，面板才识别得出')
  })

  it('移除超时后，面板输入的环境视图读得到「已摘选中」（includeEnv 回包 registered=false）', async () => {
    const { profileDir } = makeProfile()
    const manager = {
      installBundle: () => Promise.resolve(alreadyInstalled()),
      removeBundle() {
        const manifest = readProfile(profileDir)
        delete manifest.dependencies[TARGET]
        manifest.dsh = { profile: { ...(manifest.dsh?.profile ?? {}), bundles: [] } }
        writeJson(join(profileDir, 'package.json'), manifest)
        return new Promise(() => {})
      },
    }
    const outcome = await cappedSettle(
      () => call(runWith({ installTimeoutMs: 30, pluginManager: manager, log: () => {} })),
      30 + GRACE_MS + 4000
    )
    assert.equal(outcome.kind, 'failed')

    // 宿主公开入口：面板只拿得到 includeEnv 回来的环境视图（#184 起该视图转发 registered）。
    const host = makeHost(profileDir)
    const out = await host.handlers['issue184.updateStatus']({ includeEnv: true })
    assert.equal(out.ok, true)
    assert.ok(out.env, 'includeEnv 时必须带回环境视图（面板输入面）')
    assert.equal(out.env.registered, false, '面板要能从环境视图识别「清单里已没有这个包」')
  })
})
