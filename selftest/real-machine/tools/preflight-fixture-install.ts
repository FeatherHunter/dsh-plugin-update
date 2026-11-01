/**
 * selftest/real-machine/tools/preflight-fixture-install.ts —— 不启 GUI 的安装预检。
 *
 * 目的：在跑真机主链之前，先把「本地 registry + SUT 钉版 + 夹具发布 + dsh CLI 装进干净 profile」
 * 这条没有 UI 的链路验穿。它也是 T2 复用的第一道预检：夹具打不出来/装不上时，主链一定跑不通。
 *
 * 运行（仓库根）：
 *   node selftest/real-machine/tools/preflight-fixture-install.ts --run-base-dir D:\dsh-plugin\_wt263\runtime\t1-265
 * 退出码：0=全 pass；1=有 fail/unknown；2=工具/环境错误。
 */
import { join, resolve } from 'node:path'
import { createRunLayout } from '../runtime/run-layout.ts'
import { EvidenceRecorder } from '../runtime/evidence.ts'
import { createFixtureEnvironment, fixtureSpecOf } from '../runtime/fixture-environment.ts'
import { createWebProfileInHome, installPluginIntoProfile, installedPluginDir } from '../host/isolated-profile.ts'
import { readProfileManifest, profileDirOf } from '../host/dsh-cli.ts'
import { directoryFingerprint } from '../../tooling/fs-utils.ts'
import { runCommand } from '../../tooling/process.ts'

/** 取一个 --name value 形式的参数。 */
function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf('--' + name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

const worktree = resolve(argValue('worktree', process.cwd()) as string)
const runBaseDir = argValue('run-base-dir')
if (!runBaseDir) {
  console.error('[preflight] 必须传 --run-base-dir（例如 D:\\dsh-plugin\\_wt263\\runtime\\t1-265）')
  process.exit(2)
}
const verdaccioInstallDir = argValue('verdaccio-install-dir', 'D:\\dsh-plugin\\_wt263\\runtime\\tools\\verdaccio') as string
const esbuildPath = argValue('esbuild', join(worktree, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')) as string
const stamp = argValue('stamp')

const layout = await createRunLayout({ baseDir: runBaseDir, ticket: '265', stamp })
const gitBranch = runCommand('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree })
const gitHead = runCommand('git', ['-C', worktree, 'rev-parse', 'HEAD'], { cwd: worktree })
const recorder = new EvidenceRecorder({
  layout,
  scenarioId: 'preflight-fixture-install',
  environment: {
    node: process.version,
    platform: process.platform,
    worktree,
    branch: gitBranch.stdout.trim(),
    head: gitHead.stdout.trim(),
    hostChannel: 'none（registry+CLI 预检，不启 GUI）',
  },
})
await recorder.raw('run-start', { argv: process.argv.slice(2), layout })

let environment: Awaited<ReturnType<typeof createFixtureEnvironment>> | null = null
let exitCode = 2
try {
  environment = await createFixtureEnvironment({ layout, verdaccioInstallDir, sutRoot: worktree, esbuildPath })
  await recorder.raw('registry-started', { baseUrl: environment.registry.baseUrl, port: environment.registry.port })
  await recorder.raw('sut-pin', {
    name: environment.sut.name,
    version: environment.sut.version,
    tarball: environment.sut.tarball,
    tarballSha256: environment.sut.tarballSha256,
    distDigest: environment.sut.distDigest,
    distFiles: environment.sut.distFiles,
    packStdout: environment.sut.pack.stdout,
    publishStdout: environment.sut.publish.stdout,
  })
  recorder.recordAssertion({
    step: 'SUT 钉版',
    what: '工作树 npm pack 后发布到本地 registry，版本=工作树版本',
    expected: 'publish exit 0 且 registry 可见 ' + environment.sut.name + '@' + environment.sut.version,
    actual: environment.sut.name + '@' + environment.sut.version + '，tarball sha256 ' + environment.sut.tarballSha256.slice(0, 16) + '…',
    verdict: 'pass',
  })

  const publishedA = await environment.publish('a', '0.0.1')
  await recorder.raw('fixture-published', {
    spec: fixtureSpecOf(publishedA),
    dir: publishedA.built.dir,
    artifacts: publishedA.built.artifacts,
    publishStdout: publishedA.publish.stdout,
  })
  recorder.recordAssertion({
    step: '夹具发布',
    what: '夹具 A 0.0.1 由模板生成、esbuild 构建两条产物后发布到本地 registry',
    expected: '产物 4 件齐全且 registry 可见 dsh-plugin-update-fixture-a@0.0.1',
    actual: publishedA.built.artifacts.join(', '),
    verdict: 'pass',
  })

  const homeDir = layout.homeDir
  const profile = await createWebProfileInHome({ homeDir, profileName: 'preflight' })
  await recorder.raw('web-profile-created', { profileDir: profile.profileDir, exitCode: profile.create.exitCode, stdout: profile.create.stdout, stderr: profile.create.stderr })

  const install = await installPluginIntoProfile({
    homeDir,
    profileName: 'preflight',
    packageName: publishedA.plan.packageName,
    version: publishedA.plan.version,
    registryUrl: environment.registry.baseUrl,
  })
  await recorder.raw('fixture-installed', {
    spec: fixtureSpecOf(publishedA),
    exitCode: install.install.exitCode,
    stdout: install.install.stdout,
    stderr: install.install.stderr,
    facts: install.facts,
  })
  recorder.recordAssertion({
    step: '夹具安装',
    what: '干净 profile 里按 registry 版本安装夹具 A 0.0.1（非 file:）',
    expected: 'dependencies 精确版本、bundles 含包名、磁盘 package.json 版本一致',
    actual: '依赖=' + String(install.facts.dependencyVersion) + '，bundles=[' + install.facts.bundles.join(', ') + ']，磁盘版本=' + String(install.facts.installedPackageJsonVersion),
    verdict: 'pass',
  })

  const installedSutDir = join(install.facts.profileDir, 'node_modules', environment.sut.name)
  const installedFingerprint = await directoryFingerprint(join(installedSutDir, 'dist'))
  const distMatch = installedFingerprint.digest === environment.sut.distDigest
  await recorder.raw('installed-sut-dist', {
    installedSutDir,
    installedDistDigest: installedFingerprint.digest,
    worktreeDistDigest: environment.sut.distDigest,
    match: distMatch,
    files: installedFingerprint.files,
  })
  recorder.recordAssertion({
    step: 'SUT 一致性',
    what: 'profile 里实际装上的 dsh-plugin-update/dist 是否等于工作树当前构建',
    expected: '聚合指纹等于 ' + environment.sut.distDigest,
    actual: installedFingerprint.digest + '（' + installedFingerprint.files + ' 个文件）',
    verdict: distMatch ? 'pass' : 'fail',
  })

  const manifest = await readProfileManifest(profileDirOf(homeDir, 'preflight'))
  await recorder.raw('profile-manifest', manifest)
  exitCode = 0
} catch (error) {
  await recorder.raw('preflight-error', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null })
  recorder.recordAssertion({
    step: '预检总出口',
    what: '预检链路是否走通',
    expected: '无异常',
    actual: String(error),
    verdict: 'fail',
  })
  exitCode = 2
} finally {
  const cleanupNotes: string[] = []
  if (environment) {
    try {
      await environment.stop()
      cleanupNotes.push('本地 registry 已停止，端口已释放')
    } catch (error) {
      cleanupNotes.push('registry 停止失败：' + String(error))
    }
  }
  const manifest = await recorder.finish()
  console.log(JSON.stringify({ runDir: layout.root, verdict: manifest.verdict, exitCode: manifest.exitCode, notes: cleanupNotes }, null, 2))
  process.exit(exitCode === 0 ? manifest.exitCode : exitCode)
}
