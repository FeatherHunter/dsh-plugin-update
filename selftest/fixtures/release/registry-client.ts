/**
 * selftest/fixtures/release/registry-client.ts —— 本地 registry 的「建号 / 发布 / 查可见性」三件事。
 *
 * 关键事实（exploration/registry-notes.md 实测）：
 *   - 匿名 publish 必失败（ENEEDAUTH），必须先走 CouchDB 建号拿 token；
 *   - npm publish 用 --userconfig 指向本次 run 的 npmrc，绝不碰用户全局 .npmrc；
 *   - 同名版本重复发布是 E409，所以发布前/发布后都要查可见性，把结论写进证据。
 */
import { join, dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { runCommand, waitFor, type CommandResult, commandLine } from '../../tooling/process.ts'

/** 本次 run 的 registry 凭证。 */
export interface RegistryAccount {
  readonly user: string
  readonly password: string
  readonly email: string
  readonly token: string
}

/** npm CLI 入口：用当前 node 跑 npm-cli.js（不依赖 PATH 里的 .cmd 包装，参数不经过 shell 二次解析）。 */
export function npmCliPath(): string {
  return join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/** 一次 npm 命令的结果（raw 证据直接用）。 */
export interface NpmRunResult extends CommandResult {
  readonly rendered: string
}

/** 跑 npm 子命令。 */
export function runNpm(args: readonly string[], options: { cwd: string; timeoutMs?: number }): NpmRunResult {
  const npmArgs = [npmCliPath(), ...args]
  const result = runCommand(process.execPath, npmArgs, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs || 180000,
  })
  return { ...result, rendered: commandLine(process.execPath, npmArgs) }
}

/** 写本次 run 的 npmrc（registry + 该 host 的 authToken），返回路径。 */
export async function writeNpmrc(options: { dir: string; registryUrl: string; token: string }): Promise<string> {
  const match = /^https?:\/\/([^/]+)\//.exec(options.registryUrl + '/')
  if (!match) throw new Error('[fixtures] 非法 registryUrl：' + options.registryUrl)
  const host = match[1]
  const path = join(options.dir, 'npmrc')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    'registry=' + options.registryUrl + '/\n//' + host + '/:_authToken=' + options.token + '\n',
  )
  return path
}

/** 在本地 registry 建号（CouchDB 用户 API），返回 token 与账号。 */
export async function createRegistryUser(options: {
  baseUrl: string
  user: string
  password: string
  email?: string
}): Promise<RegistryAccount> {
  const email = options.email || options.user + '@selftest.invalid'
  const response = await fetch(options.baseUrl + '/-/user/org.couchdb.user:' + encodeURIComponent(options.user), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: options.user,
      password: options.password,
      email,
      type: 'user',
      roles: [],
      date: new Date().toISOString(),
    }),
  })
  const text = await response.text()
  if (response.status !== 201 && response.status !== 409) {
    throw new Error('[fixtures] 建号失败（HTTP ' + response.status + '）：' + text)
  }
  const body = JSON.parse(text) as { token?: string }
  if (!body.token) throw new Error('[fixtures] 建号成功但没拿到 token：' + text)
  return { user: options.user, password: options.password, email, token: body.token }
}

/** 发布一个包目录（目录里已有 package.json + lib/ + cordis.patch.yml）。 */
export function publishPackageDirectory(options: {
  cwd: string
  registryUrl: string
  npmrcPath: string
}): NpmRunResult {
  return runNpm(
    ['publish', '--registry=' + options.registryUrl + '/', '--userconfig=' + options.npmrcPath],
    { cwd: options.cwd },
  )
}

/** 发布一个已有 tarball（SUT 钉版用）。 */
export function publishTarball(options: {
  tarball: string
  cwd: string
  registryUrl: string
  npmrcPath: string
}): NpmRunResult {
  return runNpm(
    ['publish', options.tarball, '--registry=' + options.registryUrl + '/', '--userconfig=' + options.npmrcPath],
    { cwd: options.cwd },
  )
}

/** 一个包全部已发布版本（registry 元数据里的 dist-tags/versions 键）。 */
export async function fetchPublishedVersions(baseUrl: string, packageName: string): Promise<string[] | null> {
  const response = await fetch(baseUrl + '/' + packageName)
  if (response.status === 404) return null
  if (!response.ok) throw new Error('[fixtures] 查询 ' + packageName + ' 失败（HTTP ' + response.status + '）')
  const body = (await response.json()) as { versions?: Record<string, unknown> }
  return Object.keys(body.versions || {}).sort()
}

/** 等某个版本在本地 registry 可见（发布成功的判定；超时抛错并带包名版本）。 */
export async function waitForRegistryVersion(options: {
  baseUrl: string
  packageName: string
  version: string
  timeoutMs?: number
}): Promise<void> {
  await waitFor(
    'registry 版本可见：' + options.packageName + '@' + options.version,
    async () => {
      const versions = await fetchPublishedVersions(options.baseUrl, options.packageName)
      return versions && versions.indexOf(options.version) >= 0 ? versions : null
    },
    { timeoutMs: options.timeoutMs || 30000, intervalMs: 300 },
  )
}

/**
 * 下架一个已发布版本（故障注入：check 之后让目标版本从源上消失，后续 pnpm 解析必失败）。
 * 只对本 run 的本地 registry 用；--force 是 npm 对已发布版本下架的硬要求。
 */
export function unpublishVersion(options: {
  baseUrl: string
  packageName: string
  version: string
  npmrcPath: string
  cwd?: string
}): NpmRunResult {
  return runNpm(
    [
      'unpublish',
      options.packageName + '@' + options.version,
      '--force',
      '--registry=' + options.baseUrl + '/',
      '--userconfig=' + options.npmrcPath,
    ],
    { cwd: options.cwd || dirname(options.npmrcPath) },
  )
}

/** 等某个版本从本地 registry 消失（下架生效的判定；超时抛错并带包名版本）。 */
export async function waitForRegistryVersionGone(options: {
  baseUrl: string
  packageName: string
  version: string
  timeoutMs?: number
}): Promise<void> {
  await waitFor(
    'registry 版本已下架：' + options.packageName + '@' + options.version,
    async () => {
      const versions = await fetchPublishedVersions(options.baseUrl, options.packageName)
      return versions && versions.indexOf(options.version) < 0 ? versions : null
    },
    { timeoutMs: options.timeoutMs || 30000, intervalMs: 300 },
  )
}

/** 发布失败的统一错误（含原始命令与输出，直接进 raw 证据）。 */
export function publishFailure(result: NpmRunResult): Error {
  return new Error(
    '[fixtures] npm publish 失败（exit ' + String(result.exitCode) + '）\n命令：' + result.rendered +
      '\nstdout：' + result.stdout + '\nstderr：' + result.stderr,
  )
}
