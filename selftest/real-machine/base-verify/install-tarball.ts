/**
 * selftest/real-machine/base-verify/install-tarball.ts —— 把本仓 dist tgz 装进隔离 profile。
 *
 * 与 base 的 install 命令的差异（刻意）：base 的安装后校验要求 client entry 内嵌
 * name@version 常量（package-version-constant），那是 base 自家插件的构建约定；本仓构建
 * 不内嵌该常量，任务也要求不改产品构建。所以这里只做「解包 + 写 file: 依赖」：
 *   1. 校验 tgz 顶层 package/ 里的 package.json（name 必须是 dsh-plugin-update）；
 *   2. 解进 <profile>/node_modules/<包名>/；
 *   3. 把 profile package.json 的 dependencies[包名] 写成 file:<tarball 绝对路径>。
 * 身份链由调用方用 tarball sha256 记录；这里不验证版本常量，文档里写明这一差异。
 */
import { join, resolve } from 'node:path'
import { readJsonFile, sha256, writeJsonFile } from '../../tooling/fs-utils.ts'
import { formatError } from '../../tooling/process.ts'
import { readTarballFile, readTarballGz, writeTarEntries } from './tarball.ts'

/** 安装入参。 */
export interface TarballInstallRequest {
  readonly tarballPath: string
  /** 目标 profile 目录（<isolated-home>/profiles/<profile>）。 */
  readonly profileDir: string
  /** 期望的包名（本仓 dsh-plugin-update）。 */
  readonly packageName: string
}

/** 安装成功后的可引用身份与落点。 */
export interface TarballInstallResult {
  readonly tarballPath: string
  readonly tarballSha256: string
  readonly packageName: string
  readonly version: string
  readonly files: number
  readonly bytes: number
  readonly installedDir: string
  readonly dependencySpec: string
}

export type TarballInstallOutcome =
  | { readonly ok: true; readonly value: TarballInstallResult }
  | { readonly ok: false; readonly error: string }

function fail(error: string): TarballInstallOutcome {
  return { ok: false, error }
}

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

/** profile 包名形状校验：不允许路径分隔符或 ..（防写出 profile 目录）。 */
function isSafePackageName(name: string): boolean {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
}

/** 解包 + 改 profile 依赖；任何一步失败返回 error（不抛）。 */
export async function installTarballIntoProfile(request: TarballInstallRequest): Promise<TarballInstallOutcome> {
  if (!isSafePackageName(request.packageName)) return fail('包名不合法：' + JSON.stringify(request.packageName))
  const tarballPath = resolve(request.tarballPath)
  const read = await readTarballFile(tarballPath)
  if (!read.ok) return fail(read.error)
  const tarballSha256 = sha256(read.value)
  const parsed = readTarballGz(read.value)
  if (!parsed.ok) return fail('tarball 解析失败：' + parsed.error)
  const manifestEntry = parsed.value.files.find((entry) => entry.path === 'package.json')
  if (!manifestEntry) return fail('tarball 里没有 package/package.json')
  let manifest: { name?: string; version?: string }
  try {
    manifest = JSON.parse(decodeUtf8(manifestEntry.data)) as { name?: string; version?: string }
  } catch (error) {
    return fail('tarball 里的 package.json 不是合法 JSON：' + formatError(error))
  }
  if (manifest.name !== request.packageName) {
    return fail('tarball 包名 ' + JSON.stringify(manifest.name) + ' 与期望 ' + JSON.stringify(request.packageName) + ' 不一致')
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    return fail('tarball 版本号不合法：' + JSON.stringify(manifest.version))
  }
  const installedDir = join(request.profileDir, 'node_modules', request.packageName)
  const written = await writeTarEntries(parsed.value.files, installedDir)
  if (!written.ok) return fail('解包到 ' + installedDir + ' 失败：' + written.error)
  const profileManifestPath = join(request.profileDir, 'package.json')
  let profileManifest: { name?: string; dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
  try {
    profileManifest = await readJsonFile<{ name?: string; dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }>(profileManifestPath)
  } catch (error) {
    return fail('读不到 profile package.json（' + profileManifestPath + '）：' + formatError(error))
  }
  const dependencySpec = 'file:' + tarballPath
  const dependencies: Record<string, string> = { ...(profileManifest.dependencies ?? {}), [request.packageName]: dependencySpec }
  try {
    await writeJsonFile(profileManifestPath, { ...profileManifest, dependencies })
  } catch (error) {
    return fail('写 profile package.json 失败：' + formatError(error))
  }
  return {
    ok: true,
    value: {
      tarballPath,
      tarballSha256,
      packageName: request.packageName,
      version: manifest.version,
      files: written.value.files,
      bytes: written.value.bytes,
      installedDir,
      dependencySpec,
    },
  }
}
