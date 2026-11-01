/**
 * selftest/real-machine/host/isolated-profile.ts —— 隔离 profile 的建与装。
 *
 * 用法分层：
 *   web profile（通道 B）：dsh --profile <p> --from-default-profile web --dump-config 建；
 *   desktop profile（通道 A）：官方桌面首次启动自己建 <home>/profiles/desktop，装完插件再重启桌面。
 * 安装一律走 registry 版本（dsh plugin --profile <p> add <pkg>@<ver> --registry=...），不走 file:。
 */
import { join } from 'node:path'
import type { CommandResult } from '../../tooling/process.ts'
import { formatError } from '../../tooling/process.ts'
import { directoryExists } from '../../tooling/fs-utils.ts'
import type { InstalledPluginFacts } from './dsh-cli.ts'
import { addPluginToProfile, createWebProfile, profileDirOf, verifyPluginInstalled } from './dsh-cli.ts'

/** 建 profile 的结果。 */
export interface ProfileSetupResult {
  readonly profileName: string
  readonly profileDir: string
  readonly create: CommandResult
}

/** 建一个 web profile（通道 B 用；建失败立刻抛，带原始输出）。 */
export async function createWebProfileInHome(options: {
  homeDir: string
  profileName: string
}): Promise<ProfileSetupResult> {
  const create = createWebProfile(options.profileName, { homeDir: options.homeDir })
  if (create.exitCode !== 0) {
    throw new Error(
      '[profile] 建 web profile 失败（exit ' + String(create.exitCode) + '）\n命令：' + create.command + ' ' + create.args.join(' ') +
        '\nstdout：' + create.stdout + '\nstderr：' + create.stderr,
    )
  }
  const profileDir = profileDirOf(options.homeDir, options.profileName)
  if (!(await directoryExists(profileDir))) {
    throw new Error('[profile] 建 profile 命令成功但目录不存在：' + profileDir)
  }
  return { profileName: options.profileName, profileDir, create }
}

/** 等 profile 目录出现（通道 A：桌面首次启动自己建 profile，我们等它落地）。 */
export async function waitForProfileDir(options: {
  homeDir: string
  profileName: string
  timeoutMs: number
}): Promise<string> {
  const deadline = Date.now() + options.timeoutMs
  const profileDir = profileDirOf(options.homeDir, options.profileName)
  while (Date.now() < deadline) {
    if (await directoryExists(profileDir)) return profileDir
    await new Promise((resolve) => setTimeout(() => resolve(undefined), 300))
  }
  throw new Error('[profile] 等 profile 目录超时：' + profileDir)
}

/** 装一个夹具包并核对磁盘事实（失败抛带事实的错误）。 */
export async function installPluginIntoProfile(options: {
  homeDir: string
  profileName: string
  packageName: string
  version: string
  registryUrl: string
}): Promise<{ install: CommandResult; facts: InstalledPluginFacts }> {
  const spec = options.packageName + '@' + options.version
  const install = addPluginToProfile(spec, options.profileName, {
    homeDir: options.homeDir,
    registryUrl: options.registryUrl,
  })
  if (install.exitCode !== 0) {
    throw new Error(
      '[profile] 安装 ' + spec + ' 失败（exit ' + String(install.exitCode) + '）\n命令：' + install.command + ' ' + install.args.join(' ') +
        '\nstdout：' + install.stdout + '\nstderr：' + install.stderr,
    )
  }
  try {
    const facts = await verifyPluginInstalled({
      homeDir: options.homeDir,
      profileName: options.profileName,
      packageName: options.packageName,
      expectedVersion: options.version,
    })
    return { install, facts }
  } catch (error) {
    throw new Error(formatError(error) + '\n安装输出：' + install.stdout + '\n' + install.stderr)
  }
}

/** profile 内某包目录（装好的磁盘位置）。 */
export function installedPluginDir(options: { homeDir: string; profileName: string; packageName: string }): string {
  return join(profileDirOf(options.homeDir, options.profileName), 'node_modules', options.packageName)
}
