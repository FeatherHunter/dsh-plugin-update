/**
 * selftest/real-machine/host/dsh-cli.ts —— 隔离 DSH_HOME 下的 CLI 调用（建 profile / 装插件 / 查账）。
 *
 * 事实：dsh.cmd 本身就是「DeepSeek Harness.exe + ELECTRON_RUN_AS_NODE=1 + dsh-desktop-host/lib/cli.js」。
 * 这里别走 cmd 包装，直接用 node 语义起同一个入口：参数不经过 shell 二次解析，环境变量由我们精确控制。
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { CommandResult } from '../../tooling/process.ts'
import { formatError, runCommand } from '../../tooling/process.ts'
import { fileExists } from '../../tooling/fs-utils.ts'

/** 发行包里的固定路径（环境事实；可用环境变量覆盖以便换机器）。 */
export const DSH_PATHS = {
  exePath: process.env['DSH_SELFTEST_DESKTOP_EXE'] || 'D:\\DeepseekHarness\\DeepSeek Harness.exe',
  cliJsPath:
    process.env['DSH_SELFTEST_DESKTOP_CLI_JS'] ||
    'D:\\DeepseekHarness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
}

/** CLI 调用入参。 */
export interface DshCliOptions {
  /** 隔离 DSH_HOME（本 run 的 home/）。 */
  readonly homeDir: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly extraEnv?: Record<string, string | undefined>
}

/** 组装 CLI 子进程环境：隔离 home + ELECTRON_RUN_AS_NODE + 可选覆盖。 */
export function dshCliEnv(options: DshCliOptions): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  env['DSH_HOME'] = options.homeDir
  env['ELECTRON_RUN_AS_NODE'] = '1'
  for (const [key, value] of Object.entries(options.extraEnv || {})) env[key] = value
  return env
}

/** 跑一条 dsh CLI 命令（不抛；调用方按 exitCode 判）。 */
export function runDshCli(args: readonly string[], options: DshCliOptions): CommandResult {
  if (!(options.homeDir && options.homeDir.length > 0)) throw new Error('[dsh-cli] 必须显式传隔离 homeDir')
  const fullArgs = ['--expose-internals', DSH_PATHS.cliJsPath, ...args]
  return runCommand(DSH_PATHS.exePath, fullArgs, {
    cwd: options.cwd || options.homeDir,
    env: dshCliEnv(options),
    timeoutMs: options.timeoutMs || 300000,
  })
}

/** 建一个 web 类型 profile（--from-default-profile；与 exploration 实测命令一致）。 */
export function createWebProfile(profileName: string, options: DshCliOptions): CommandResult {
  return runDshCli(['--profile', profileName, '--from-default-profile', 'web', '--dump-config'], options)
}

/** 往 profile 里装一个包（registry 版本；--registry 原样转发给 pnpm）。 */
export function addPluginToProfile(pluginSpec: string, profileName: string, options: DshCliOptions & { registryUrl: string }): CommandResult {
  return runDshCli(
    ['plugin', '--profile', profileName, 'add', pluginSpec, '--registry=' + options.registryUrl + '/'],
    options,
  )
}

/** 从 profile 里移除一个包（备选路径用；不影响主链）。 */
export function removePluginFromProfile(packageName: string, profileName: string, options: DshCliOptions): CommandResult {
  return runDshCli(['plugin', '--profile', profileName, 'remove', packageName], options)
}

/** profile 目录（DSH_HOME/profiles/<name>）。 */
export function profileDirOf(homeDir: string, profileName: string): string {
  return join(homeDir, 'profiles', profileName)
}

/** 读 profile 的 package.json（安装结果的磁盘事实）。 */
export async function readProfileManifest(profileDir: string): Promise<{
  name?: string
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}> {
  const path = join(profileDir, 'package.json')
  try {
    return JSON.parse(await readFile(path, 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
  } catch (error) {
    throw new Error('[dsh-cli] 读 profile 清单失败：' + path + '；' + formatError(error))
  }
}

/** 装完后的硬校验：目录、清单 dependencies、bundles、包内 package.json 版本都在。 */
export interface InstalledPluginFacts {
  readonly profileDir: string
  readonly dependencyVersion: string | null
  readonly bundles: readonly string[]
  readonly installedPackageJsonVersion: string | null
  readonly installedDir: string
}

/** 读 profile 里某包磁盘版本（没有就返回 null；更新前后对比用）。 */
export async function readInstalledPackageVersion(options: {
  homeDir: string
  profileName: string
  packageName: string
}): Promise<string | null> {
  const manifestPath = join(profileDirOf(options.homeDir, options.profileName), 'node_modules', options.packageName, 'package.json')
  if (!(await fileExists(manifestPath))) return null
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: string }
    return parsed.version || null
  } catch (error) {
    return null
  }
}

/** 核对一个包确实装进了 profile（失败抛出带三次事实的错误）。 */
export async function verifyPluginInstalled(options: {
  homeDir: string
  profileName: string
  packageName: string
  expectedVersion: string
}): Promise<InstalledPluginFacts> {
  const profileDir = profileDirOf(options.homeDir, options.profileName)
  const manifest = await readProfileManifest(profileDir)
  const dependencyVersion = (manifest.dependencies || {})[options.packageName] || null
  const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
  const installedDir = join(profileDir, 'node_modules', options.packageName)
  let installedPackageJsonVersion: string | null = null
  const installedManifestPath = join(installedDir, 'package.json')
  if (await fileExists(installedManifestPath)) {
    const installed = JSON.parse(await readFile(installedManifestPath, 'utf8')) as { version?: string }
    installedPackageJsonVersion = installed.version || null
  }
  const problems: string[] = []
  if (dependencyVersion !== options.expectedVersion) problems.push('dependencies 版本=' + String(dependencyVersion) + '（期望 ' + options.expectedVersion + '）')
  if (bundles.indexOf(options.packageName) < 0) problems.push('bundles 未包含该包（实际 [' + bundles.join(', ') + ']）')
  if (installedPackageJsonVersion !== options.expectedVersion) problems.push('磁盘包版本=' + String(installedPackageJsonVersion) + '（期望 ' + options.expectedVersion + '）')
  if (problems.length > 0) {
    throw new Error('[dsh-cli] ' + options.packageName + ' 未按 ' + options.expectedVersion + ' 正确安装：\n- ' + problems.join('\n- ') + '\nprofile=' + profileDir)
  }
  return { profileDir, dependencyVersion, bundles, installedPackageJsonVersion, installedDir }
}
