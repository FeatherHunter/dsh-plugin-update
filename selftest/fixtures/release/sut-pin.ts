/**
 * selftest/fixtures/release/sut-pin.ts —— 把「当前工作树构建产物」钉成本次真机被测的更新系统。
 *
 * 第一性原理：真机里跑的不是 npm 上的 0.18.39，而是这份工作树的 dist。做法是把工作树 npm pack 成
 * tarball，并以工作树自己的版本号发布到本次 run 的本地 registry（同名同版本本地覆盖上游查询），
 * 夹具依赖 dsh-plugin-update@<version> 于是只能从本地 registry 拿到它；证据里再用 dist 聚合哈希核对
 * 「profile 里装的 dist == 本地 tarball 里的 dist == 当前工作树 dist」。
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { NpmRunResult } from './registry-client.ts'
import { publishFailure, publishTarball, runNpm, waitForRegistryVersion } from './registry-client.ts'
import { directoryFingerprint, ensureDir, fileExists, sha256File } from '../../tooling/fs-utils.ts'

/** 钉住的 SUT 版本（tarball + 内容指纹）。 */
export interface SutPin {
  readonly name: string
  readonly version: string
  readonly tarball: string
  readonly tarballSha256: string
  /** 工作树 dist/ 的聚合指纹（与安装后 profile 里的 dist 对比用）。 */
  readonly distDigest: string
  readonly distFiles: number
  readonly pack: NpmRunResult
  readonly publish: NpmRunResult
}

/** npm pack 工作树（不发布）；返回 tarball 路径与元信息。 */
export async function packSut(options: {
  sutRoot: string
  packDir: string
}): Promise<{ name: string; version: string; tarball: string; pack: NpmRunResult; distDigest: string; distFiles: number }> {
  const distDir = join(options.sutRoot, 'dist')
  if (!(await fileExists(join(distDir, 'host.js')))) {
    throw new Error('[fixtures] 工作树没有 dist 构建产物：先在 ' + options.sutRoot + ' 跑 npm run build')
  }
  await ensureDir(options.packDir)
  const pack = runNpm(['pack', '--pack-destination', options.packDir], { cwd: options.sutRoot })
  if (pack.exitCode !== 0) {
    throw new Error('[fixtures] npm pack 失败（exit ' + String(pack.exitCode) + '）\n命令：' + pack.rendered + '\nstdout：' + pack.stdout + '\nstderr：' + pack.stderr)
  }
  const manifest = JSON.parse(await readFile(join(options.sutRoot, 'package.json'), 'utf8')) as { name: string; version: string }
  const tarballName = manifest.name + '-' + manifest.version + '.tgz'
  const tarball = join(options.packDir, tarballName)
  if (!(await fileExists(tarball))) {
    throw new Error('[fixtures] npm pack 后找不到 tarball：' + tarball + '\nstdout：' + pack.stdout)
  }
  const fingerprint = await directoryFingerprint(distDir)
  return {
    name: manifest.name,
    version: manifest.version,
    tarball,
    pack,
    distDigest: fingerprint.digest,
    distFiles: fingerprint.files,
  }
}

/** 打包 + 发布到本次 run 的本地 registry + 等可见。 */
export async function pinSutForRegistry(options: {
  sutRoot: string
  packDir: string
  registryUrl: string
  npmrcPath: string
}): Promise<SutPin> {
  const packed = await packSut({ sutRoot: options.sutRoot, packDir: options.packDir })
  const publish = publishTarball({
    tarball: packed.tarball,
    cwd: options.packDir,
    registryUrl: options.registryUrl,
    npmrcPath: options.npmrcPath,
  })
  if (publish.exitCode !== 0) throw publishFailure(publish)
  await waitForRegistryVersion({ baseUrl: options.registryUrl, packageName: packed.name, version: packed.version })
  return {
    name: packed.name,
    version: packed.version,
    tarball: packed.tarball,
    tarballSha256: await sha256File(packed.tarball),
    distDigest: packed.distDigest,
    distFiles: packed.distFiles,
    pack: packed.pack,
    publish,
  }
}
