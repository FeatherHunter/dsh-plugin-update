/**
 * selftest/fixtures/release/npmjs-mirror.ts —— 把 SUT 的 npmjs 运行时依赖镜像进本次 run 的本地 registry。
 *
 * 为什么需要：夹具安装 fixture-a@0.0.1 时，pnpm 要经本次 run 的 verdaccio 拉 SUT 的运行时依赖
 * （当前是 dsh-log@^0.4.1）。verdaccio 的 npmjs uplink 是「按需流式回源」，今天连续跑几十个 run
 * 后会被上游限流/超时（#269 实测 215839/220513 两次 unknown 都是 dsh-log 拉取失败）。这不是产品
 * BUG，而是夹具环境非确定性：每个 run 都在赌 npmjs 实时可达。
 *
 * 做法（第一性原理：一次 run 只允许「解析依赖版本」这一步用网络，且结果可缓存）：
 *   1. 读 SUT package.json 的 dependencies；对每个依赖用 npm view 解析确切版本（写入 resolved.json 缓存）；
 *   2. 用 npm pack 把该版本 tarball 缓存到仓库外 cacheDir（后续 run 命中缓存，不再联网）；
 *   3. 起好本次 run 的 verdaccio 后，把镜像 tarball 发布进去，并让该包走「不吃上游」的本地规则。
 * 这样一次真机 run 从基版安装到批量更新全程只跟本地 registry 打交道，npmjs 只在缓存冷启动时用一次。
 *
 * 失败语义：解析/打包/发布任一步失败都抛「环境错误」（runner 以 exit 2 blocked 结束），绝不把网络
 * 故障留到基版安装里变成难归因的 unknown。
 */
import { readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NpmRunResult } from './registry-client.ts'
import { fetchPublishedVersions, publishFailure, publishTarball, runNpm, waitForRegistryVersion } from './registry-client.ts'
import { ensureDir, fileExists, sha256File, writeJsonFile } from '../../tooling/fs-utils.ts'

/** 镜像的上游 registry（只在这一层用网络）。 */
export const NPMJS_REGISTRY = 'https://registry.npmjs.org/'

/** 一条要镜像的依赖声明（来自 SUT package.json）。 */
export interface MirrorDependencySpec {
  readonly name: string
  readonly range: string
}

/** resolved.json 里的一条缓存事实。 */
export interface ResolvedCacheEntry {
  readonly version: string
  readonly range: string
  /** 缓存 tarball 的 sha256（用于每次复用前核对缓存没被改坏）。 */
  readonly sha256?: string
  readonly resolvedAt?: string
}

/** resolved.json 的形状（包名 → 缓存事实）。 */
export type ResolvedCache = Record<string, ResolvedCacheEntry>

/** 一条已解析、已缓存（尚未发布）的镜像依赖。 */
export interface NpmjsMirrorDependency {
  readonly name: string
  readonly range: string
  readonly version: string
  /** 版本是从缓存读的，还是本次 npm view 解析的。 */
  readonly resolvedFrom: 'cache' | 'npmjs'
  readonly cachePath: string
  readonly sha256: string
  /** tarball 是命中缓存复用，还是本次 npm pack 新打的。 */
  readonly packedFromCache: boolean
}

/** 一次 run 的镜像计划（解析/缓存阶段，registry 还没起来）。 */
export interface NpmjsMirrorPlan {
  readonly cacheDir: string
  readonly resolvedFile: string
  readonly dependencies: readonly NpmjsMirrorDependency[]
}

/** 一条已发布进本次 run registry 的镜像依赖。 */
export interface NpmjsMirrorDependencyFacts extends NpmjsMirrorDependency {
  readonly publish: {
    readonly exitCode: number | null
    readonly rendered: string
    readonly stdout: string
    readonly stderr: string
  }
  readonly registryVersions: string[] | null
}

/** 镜像完成的证据事实（写进 raw/03-dependency-mirror.json）。 */
export interface NpmjsMirrorFacts {
  readonly cacheDir: string
  readonly resolvedFile: string
  readonly dependencies: readonly NpmjsMirrorDependencyFacts[]
}

/** 默认缓存目录：与 verdaccio 共享安装目录同级（仓库外 runtime/tools/npmjs-mirror）。 */
export function defaultMirrorCacheDir(verdaccioInstallDir: string): string {
  return join(dirname(verdaccioInstallDir), 'npmjs-mirror')
}

/** 缓存 tarball 的文件名（作用域包展平成 scope__name-version.tgz，避免目录穿越）。 */
export function mirrorCacheFileName(name: string, version: string): string {
  const flat = name.replace(/^@/, '').replace(/[\\/]/g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
  return flat + '-' + version + '.tgz'
}

/** 比较两个 semver 版本号（只做镜像解析用的「取最高」判断；解析不了的按字典序）。 */
export function compareVersionStrings(left: string, right: string): number {
  const parse = (value: string): { numbers: number[]; prerelease: boolean } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value)
    if (!match) return null
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: Boolean(match[4]) }
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return left.localeCompare(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1
  return left.localeCompare(right)
}

/** 从一组版本里取最高版本（空数组抛错）。 */
export function highestVersion(versions: readonly string[]): string {
  if (versions.length === 0) throw new Error('[fixtures] npmjs 镜像：版本列表为空，无法选择')
  return versions.slice().sort(compareVersionStrings)[versions.length - 1]
}

/** 解析 npm view <name>@<range> version --json 的输出（单版本是字符串，多版本是数组）。 */
export function parseNpmViewVersion(stdout: string): string {
  const text = stdout.trim()
  if (text.length === 0) throw new Error('[fixtures] npmjs 镜像：npm view 没有输出')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('[fixtures] npmjs 镜像：npm view 输出不是 JSON：' + text.slice(0, 400))
  }
  if (typeof parsed === 'string' && parsed.length > 0) return parsed
  if (Array.isArray(parsed)) {
    const versions = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return highestVersion(versions)
  }
  throw new Error('[fixtures] npmjs 镜像：npm view 输出无法解析：' + text.slice(0, 400))
}

/** 宽容读 resolved.json：文件不存在/坏 JSON/条目形状不对都当空缓存（下次重新联网解析）。 */
export async function readResolvedCache(file: string): Promise<ResolvedCache> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    return {}
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const cache: ResolvedCache = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (typeof entry['version'] !== 'string' || typeof entry['range'] !== 'string') continue
    cache[name] = {
      version: entry['version'],
      range: entry['range'],
      sha256: typeof entry['sha256'] === 'string' ? entry['sha256'] : undefined,
      resolvedAt: typeof entry['resolvedAt'] === 'string' ? entry['resolvedAt'] : undefined,
    }
  }
  return cache
}

/** 把一条解析结果并入 resolved.json（键排序，便于人读/审查）；返回合并后的全部缓存。 */
export async function writeResolvedCacheEntry(file: string, name: string, entry: ResolvedCacheEntry): Promise<ResolvedCache> {
  const cache = await readResolvedCache(file)
  cache[name] = entry
  const sorted: ResolvedCache = {}
  for (const key of Object.keys(cache).sort()) sorted[key] = cache[key]
  await writeJsonFile(file, sorted)
  return sorted
}

/** 读 SUT package.json 的 dependencies（跳过非字符串值；按包名排序保证输出稳定）。 */
export async function readSutDependencies(sutRoot: string): Promise<MirrorDependencySpec[]> {
  const manifest = JSON.parse(await readFile(join(sutRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
  const dependencies = manifest.dependencies || {}
  const specs: MirrorDependencySpec[] = []
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range === 'string' && range.length > 0) specs.push({ name, range })
  }
  return specs.sort((left, right) => left.name.localeCompare(right.name))
}

/** 解析版本：命中缓存且 range 没变 → 不联网；否则 npm view（唯一联网点）并写缓存。 */
async function resolveVersion(options: {
  spec: MirrorDependencySpec
  cache: ResolvedCache
  cacheDir: string
  resolvedFile: string
}): Promise<{ version: string; resolvedFrom: 'cache' | 'npmjs' }> {
  const cached = options.cache[options.spec.name]
  if (cached && cached.range === options.spec.range) {
    return { version: cached.version, resolvedFrom: 'cache' }
  }
  const view = runNpm(
    ['view', options.spec.name + '@' + options.spec.range, 'version', '--json', '--registry=' + NPMJS_REGISTRY],
    { cwd: options.cacheDir, timeoutMs: 120000 },
  )
  if (view.exitCode !== 0) {
    throw new Error(
      '[fixtures] npmjs 镜像：解析 ' + options.spec.name + '@' + options.spec.range + ' 失败（环境错误）\n' +
        '命令：' + view.rendered + '\nstdout：' + view.stdout + '\nstderr：' + view.stderr,
    )
  }
  const version = parseNpmViewVersion(view.stdout)
  await writeResolvedCacheEntry(options.resolvedFile, options.spec.name, {
    version,
    range: options.spec.range,
    resolvedAt: new Date().toISOString(),
  })
  options.cache[options.spec.name] = { version, range: options.spec.range }
  return { version, resolvedFrom: 'npmjs' }
}

/** 从 npmjs npm pack 一个确切版本到 cacheDir，返回缓存路径与 sha256。 */
async function packDependency(options: {
  name: string
  version: string
  cacheDir: string
}): Promise<{ cachePath: string; sha256: string; pack: NpmRunResult }> {
  const cachePath = join(options.cacheDir, mirrorCacheFileName(options.name, options.version))
  if (await fileExists(cachePath)) await rm(cachePath, { force: true })
  const pack = runNpm(
    ['pack', options.name + '@' + options.version, '--json', '--pack-destination', options.cacheDir, '--registry=' + NPMJS_REGISTRY],
    { cwd: options.cacheDir, timeoutMs: 180000 },
  )
  if (pack.exitCode !== 0) {
    throw new Error(
      '[fixtures] npmjs 镜像：打包 ' + options.name + '@' + options.version + ' 失败（环境错误）\n' +
        '命令：' + pack.rendered + '\nstdout：' + pack.stdout + '\nstderr：' + pack.stderr,
    )
  }
  let packedFileName: string | null = null
  try {
    const parsed = JSON.parse(pack.stdout.trim()) as unknown
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as Record<string, unknown>
      if (typeof first['filename'] === 'string') packedFileName = first['filename']
    }
  } catch (error) {
    // --json 输出解析不了就走下面的既有文件兜底
  }
  const packedPath = packedFileName ? join(options.cacheDir, packedFileName) : cachePath
  if (!(await fileExists(packedPath))) {
    throw new Error(
      '[fixtures] npmjs 镜像：npm pack 后找不到 tarball（' + packedPath + '）\nstdout：' + pack.stdout + '\nstderr：' + pack.stderr,
    )
  }
  if (packedPath !== cachePath) await rename(packedPath, cachePath)
  return { cachePath, sha256: await sha256File(cachePath), pack }
}

/**
 * 第一阶段（registry 起来之前）：解析 SUT 依赖的确切版本并确保 tarball 在缓存里。
 * 只有「缓存冷/range 变化/缓存 tarball 缺失或被改坏」时才联网；任一步失败抛环境错误。
 */
export async function resolveNpmjsMirror(options: { sutRoot: string; cacheDir: string }): Promise<NpmjsMirrorPlan> {
  await ensureDir(options.cacheDir)
  const resolvedFile = join(options.cacheDir, 'resolved.json')
  const cache = await readResolvedCache(resolvedFile)
  const specs = await readSutDependencies(options.sutRoot)
  const dependencies: NpmjsMirrorDependency[] = []
  for (const spec of specs) {
    const resolved = await resolveVersion({ spec, cache, cacheDir: options.cacheDir, resolvedFile })
    const expected = cache[spec.name]
    const cachedPath = join(options.cacheDir, mirrorCacheFileName(spec.name, resolved.version))
    let packedFromCache = false
    let sha256: string
    if (await fileExists(cachedPath)) {
      sha256 = await sha256File(cachedPath)
      const recorded = expected ? expected.sha256 : undefined
      if (recorded && recorded !== sha256) {
        // 缓存 tarball 被改坏（或不是同一份）：重新 npm pack；绝不用坏缓存去发布。
        const repacked = await packDependency({ name: spec.name, version: resolved.version, cacheDir: options.cacheDir })
        sha256 = repacked.sha256
        await writeResolvedCacheEntry(resolvedFile, spec.name, {
          version: resolved.version,
          range: spec.range,
          sha256,
          resolvedAt: new Date().toISOString(),
        })
      } else {
        packedFromCache = true
      }
    } else {
      const packed = await packDependency({ name: spec.name, version: resolved.version, cacheDir: options.cacheDir })
      sha256 = packed.sha256
      await writeResolvedCacheEntry(resolvedFile, spec.name, {
        version: resolved.version,
        range: spec.range,
        sha256,
        resolvedAt: new Date().toISOString(),
      })
    }
    dependencies.push({
      name: spec.name,
      range: spec.range,
      version: resolved.version,
      resolvedFrom: resolved.resolvedFrom,
      cachePath: cachedPath,
      sha256,
      packedFromCache,
    })
  }
  return { cacheDir: options.cacheDir, resolvedFile, dependencies }
}

/**
 * 第二阶段（registry 起来之后）：把镜像 tarball 发布进本次 run 的 registry 并等可见。
 * 该包必须已由调用方在 verdaccio config 里配成「不吃上游」的本地规则，否则同版本会被上游 409 拒。
 */
export async function publishNpmjsMirror(options: {
  plan: NpmjsMirrorPlan
  registryUrl: string
  npmrcPath: string
}): Promise<NpmjsMirrorFacts> {
  const dependencies: NpmjsMirrorDependencyFacts[] = []
  for (const dependency of options.plan.dependencies) {
    const publish = publishTarball({
      tarball: dependency.cachePath,
      cwd: options.plan.cacheDir,
      registryUrl: options.registryUrl,
      npmrcPath: options.npmrcPath,
      extraArgs: ['--ignore-scripts'],
    })
    if (publish.exitCode !== 0) {
      throw new Error(
        '[fixtures] npmjs 镜像：发布 ' + dependency.name + '@' + dependency.version + ' 失败（环境错误）\n' +
          publishFailure(publish).message,
      )
    }
    await waitForRegistryVersion({
      baseUrl: options.registryUrl,
      packageName: dependency.name,
      version: dependency.version,
    })
    const registryVersions = await fetchPublishedVersions(options.registryUrl, dependency.name).catch(() => null)
    dependencies.push({
      ...dependency,
      publish: {
        exitCode: publish.exitCode,
        rendered: publish.rendered,
        stdout: publish.stdout,
        stderr: publish.stderr,
      },
      registryVersions,
    })
  }
  return { cacheDir: options.plan.cacheDir, resolvedFile: options.plan.resolvedFile, dependencies }
}
