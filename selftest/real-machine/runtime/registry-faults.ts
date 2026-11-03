/**
 * selftest/real-machine/runtime/registry-faults.ts —— 真机失败格的 registry 故障注入：删 tarball、保元数据。
 *
 * 为什么不用「下架版本」：产品在安装前有一道候选门（src/core/service.ts:927-1007 installCandidate）：
 * 会重取版本文档并与检查更新时记下的 release 逐字节比对，不一致就诚实拒绝（check-expired），
 * 根本不会进 pnpm/exec。要观察「移除步成功、重装步失败」的真实失败面，必须让**元数据不变**
 * （门能过），只让 pnpm 下载 tarball 时 404 —— 这就是本文件做的事。
 *
 * 另一个前提：pnpm 的共享 store 可能已经缓存过同 integrity 的 tarball（命中缓存就不会发请求，
 * 删 tarball 也测不出失败）。所以调用方要给失败格的变体版用「本 run 独有的内容」构建
 * （带注入标记 ⇒ tarball integrity 与历史 run 不同 ⇒ store 必然 miss）；故障注入本身不碰 store。
 *
 * 证据纪律：删之前先备份 tarball、记「删前 200 / 删后 404 / 版本文档一字不差」三件事；
 * 恢复后再用同一 URL 探一次 200，保证后续「真机执行手工命令」不是拿坏源跑的。
 */
import { createHash } from 'node:crypto'
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { LocalRegistry } from '../../fixtures/release/local-registry.ts'
import { ensureDir, fileExists } from '../../tooling/fs-utils.ts'

/** 删 tarball 故障的完整事实（直接进 raw 证据）。 */
export interface TarballFault {
  readonly packageName: string
  readonly version: string
  /** 元数据里记的 tarball 地址（缺 dist.tarball 时按 registry 约定拼）。 */
  readonly tarballUrl: string
  /** verdaccio storage 里的 tarball 绝对路径。 */
  readonly tarballPath: string
  /** 备份文件绝对路径。 */
  readonly backupPath: string
  readonly sizeBefore: number
  /** 删之前的版本文档 JSON（stringify 后）。 */
  readonly versionDocBefore: string
  /** 删之后的版本文档 JSON（stringify 后）。 */
  readonly versionDocAfter: string
  readonly versionDocUnchanged: boolean
  /** 删之前 GET tarballUrl 的状态码与字节数。 */
  readonly servedBeforeStatus: number
  readonly servedBeforeBytes: number
  /** 删之后 GET tarballUrl 的状态码与响应体摘录（期望 404）。 */
  readonly servedAfterStatus: number
  readonly servedAfterBody: string
}

/** 恢复 tarball 的结果。 */
export interface TarballRestore {
  readonly restoredStatus: number
  readonly versionDocUnchanged: boolean
}

/**
 * 一次 GET（网络错误折成状态码 0 与错误文本，别让证据采集自己抛）。
 * 说明：工具层 ambient 的 fetch 没有 signal/AbortSignal，这里不设超时；tarball 走本机 verdaccio，
 * 正常都在毫秒级返回。bytes 是 UTF-8 解码后的字符数（tarball 是二进制，仅供「非空」用；精确字节看 sizeBefore）。
 */
async function get(url: string): Promise<{ status: number; body: string; bytes: number }> {
  try {
    const response = await fetch(url)
    const text = await response.text()
    return { status: response.status, body: text, bytes: text.length }
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error), bytes: 0 }
  }
}

/** 取一个包的元数据原文（失败抛错：故障注入前的基线必须有）。 */
async function fetchMetadata(baseUrl: string, packageName: string): Promise<{ text: string; body: { versions?: Record<string, Record<string, unknown>> } }> {
  const response = await fetch(baseUrl + '/' + packageName)
  const text = await response.text()
  if (!response.ok) throw new Error('[faults] 读元数据失败（HTTP ' + String(response.status) + '）：' + text.slice(0, 400))
  return { text, body: JSON.parse(text) as { versions?: Record<string, Record<string, unknown>> } }
}

/** 版本文档的稳定 JSON（对象键序由 JSON.parse 保持原序，比对足够）。 */
function versionDocJson(metadata: { versions?: Record<string, unknown> }, version: string): string {
  const doc = metadata.versions ? metadata.versions[version] : undefined
  if (!doc) throw new Error('[faults] 元数据里没有版本 ' + version)
  return JSON.stringify(doc)
}

/** 元数据里该版本的 tarball 地址；缺 dist.tarball 时按 registry 约定拼。 */
function tarballUrlOf(versionDoc: Record<string, unknown>, baseUrl: string, packageName: string, version: string): string {
  const dist = versionDoc['dist'] as Record<string, unknown> | undefined
  const url = dist && typeof dist['tarball'] === 'string' ? (dist['tarball'] as string) : ''
  return url || baseUrl + '/' + packageName + '/-/' + packageName + '-' + version + '.tgz'
}

/** verdaccio storage 里 tarball 的绝对路径（storage/<pkg>/<pkg>-<version>.tgz）。 */
export function tarballStoragePath(registry: LocalRegistry, packageName: string, version: string): string {
  return join(registry.verdaccio.storageDir, packageName, packageName + '-' + version + '.tgz')
}

/**
 * 故障注入第一步：把某版本的 tarball 从 registry storage 删掉（元数据原样保留），
 * 并把「删前 200 / 删后 404 / 版本文档不变」三件事收成一份事实。
 */
export async function removePublishedTarball(options: {
  registry: LocalRegistry
  backupDir: string
  packageName: string
  version: string
}): Promise<TarballFault> {
  const { registry, packageName, version } = options
  const baseUrl = registry.baseUrl
  const metadataBefore = await fetchMetadata(baseUrl, packageName)
  const versionDoc = (metadataBefore.body.versions || {})[version]
  if (!versionDoc) throw new Error('[faults] 元数据里没有 ' + packageName + '@' + version)
  const tarballUrl = tarballUrlOf(versionDoc, baseUrl, packageName, version)
  const tarballPath = tarballStoragePath(registry, packageName, version)
  if (!(await fileExists(tarballPath))) throw new Error('[faults] registry storage 里没有 tarball：' + tarballPath)
  const before = await get(tarballUrl)
  const sizeBefore = (await stat(tarballPath)).size
  await ensureDir(options.backupDir)
  const backupPath = join(options.backupDir, basename(tarballPath))
  await cp(tarballPath, backupPath)
  await rm(tarballPath)
  const after = await get(tarballUrl)
  const metadataAfter = await fetchMetadata(baseUrl, packageName)
  const versionDocBefore = versionDocJson(metadataBefore.body, version)
  const versionDocAfter = versionDocJson(metadataAfter.body, version)
  return {
    packageName,
    version,
    tarballUrl,
    tarballPath,
    backupPath,
    sizeBefore,
    versionDocBefore,
    versionDocAfter,
    versionDocUnchanged: versionDocBefore === versionDocAfter,
    servedBeforeStatus: before.status,
    servedBeforeBytes: before.bytes,
    servedAfterStatus: after.status,
    servedAfterBody: after.body.slice(0, 800),
  }
}

/** 故障注入收尾：把备份 tarball 拷回 storage，等同一 URL 重新 200，并复核版本文档没变。 */
export async function restorePublishedTarball(options: {
  registry: LocalRegistry
  fault: TarballFault
  timeoutMs?: number
}): Promise<TarballRestore> {
  const { registry, fault } = options
  await ensureDir(join(registry.verdaccio.storageDir, fault.packageName))
  await cp(fault.backupPath, fault.tarballPath)
  const deadline = Date.now() + (options.timeoutMs || 30000)
  let restoredStatus = 0
  while (Date.now() < deadline) {
    const probe = await get(fault.tarballUrl)
    restoredStatus = probe.status
    if (probe.status === 200) break
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 300))
  }
  const metadataAfter = await fetchMetadata(registry.baseUrl, fault.packageName)
  return {
    restoredStatus,
    versionDocUnchanged: versionDocJson(metadataAfter.body, fault.version) === fault.versionDocBefore,
  }
}

/**
 * 预热一个上游依赖的 tarball（经 verdaccio uplink 缓存到本地 storage），
 * 避免失败格真正的根因被「依赖下载失败」掩盖。返回探测到的状态码。
 */
export async function warmRegistryTarball(options: {
  registry: LocalRegistry
  packageName: string
  version: string
}): Promise<{ url: string; status: number; bytes: number }> {
  const url = options.registry.baseUrl + '/' + options.packageName + '/-/' + options.packageName + '-' + options.version + '.tgz'
  const probe = await get(url)
  return { url, status: probe.status, bytes: probe.bytes }
}

/** 改坏 tarball 字节故障的完整事实（元数据/integrity 一字不动，只让 pnpm 下载校验失败）。 */
export interface TarballCorruptionFault {
  readonly packageName: string
  readonly version: string
  readonly tarballUrl: string
  readonly tarballPath: string
  readonly backupPath: string
  /** tarball 原始字节数（改坏只翻同一段字节，文件大小不变）。 */
  readonly sizeBytes: number
  readonly sha256Before: string
  readonly sha256After: string
  /** 被改坏的字节偏移与长度（取自 tarball 中点，避开 gzip 头；sha 必变 ⇒ pnpm integrity 校验必失败）。 */
  readonly corruptedOffset: number
  readonly corruptedLength: number
  readonly versionDocBefore: string
  readonly versionDocAfter: string
  readonly versionDocUnchanged: boolean
  /** 改坏前后 GET tarballUrl 的状态码与响应字节数（都应 200，大小不变 ⇒ 不是 404 型故障）。 */
  readonly servedBeforeStatus: number
  readonly servedBeforeBytes: number
  readonly servedAfterStatus: number
  readonly servedAfterBytes: number
}

/** 恢复改坏 tarball 的结果。 */
export interface TarballCorruptionRestore {
  readonly restoredStatus: number
  readonly restoredSha256: string
  /** 恢复后的字节哈希是否等于改坏前（true 才证明后续安装不是拿坏源跑的）。 */
  readonly shaMatches: boolean
  readonly versionDocUnchanged: boolean
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 故障注入第二步（部分失败隔离格）：**元数据不动、只把已发布 tarball 的字节改坏**。
 *
 * 与「删 tarball」的区别：删掉是 404（pnpm 报包不存在，产品可能落 recovery-required/install-failed），
 * 改坏字节是 **200 + integrity 不匹配**（pnpm 报 ERR_PNPM_TARBALL_INTEGRITY），更贴近「版本存在但内容坏了」。
 * 关键纪律不变：版本文档（含 dist.integrity）一字不动，所以候选门能过、check 正常显示可更新，
 * 失败只会落在 install 这一步——这正是票面「坏版本不影响其他行」要观察的失败面。
 */
export async function corruptPublishedTarball(options: {
  registry: LocalRegistry
  backupDir: string
  packageName: string
  version: string
  /** 改坏多少字节（默认 64；从 tarball 中点开始翻位，保证命中压缩体而不仅是头部）。 */
  corruptLength?: number
}): Promise<TarballCorruptionFault> {
  const { registry, packageName, version } = options
  const baseUrl = registry.baseUrl
  const metadataBefore = await fetchMetadata(baseUrl, packageName)
  const versionDoc = (metadataBefore.body.versions || {})[version]
  if (!versionDoc) throw new Error('[faults] 元数据里没有 ' + packageName + '@' + version)
  const tarballUrl = tarballUrlOf(versionDoc, baseUrl, packageName, version)
  const tarballPath = tarballStoragePath(registry, packageName, version)
  if (!(await fileExists(tarballPath))) throw new Error('[faults] registry storage 里没有 tarball：' + tarballPath)
  const servedBefore = await get(tarballUrl)
  const original = await readFile(tarballPath)
  const sha256Before = sha256Of(original)
  const sizeBytes = original.length
  const length = Math.min(options.corruptLength ?? 64, 64)
  if (sizeBytes < length + 128) throw new Error('[faults] tarball 太小，无法安全改坏：' + String(sizeBytes) + ' 字节')
  const corruptedOffset = Math.floor(sizeBytes / 2)
  const mutated = Buffer.from(original)
  for (let index = 0; index < length; index += 1) mutated[corruptedOffset + index] = mutated[corruptedOffset + index]! ^ 0xff
  await ensureDir(options.backupDir)
  const backupPath = join(options.backupDir, basename(tarballPath))
  await cp(tarballPath, backupPath)
  await writeFile(tarballPath, mutated)
  const servedAfter = await get(tarballUrl)
  const metadataAfter = await fetchMetadata(baseUrl, packageName)
  const versionDocBefore = versionDocJson(metadataBefore.body, version)
  const versionDocAfter = versionDocJson(metadataAfter.body, version)
  return {
    packageName,
    version,
    tarballUrl,
    tarballPath,
    backupPath,
    sizeBytes,
    sha256Before,
    sha256After: sha256Of(mutated),
    corruptedOffset,
    corruptedLength: length,
    versionDocBefore,
    versionDocAfter,
    versionDocUnchanged: versionDocBefore === versionDocAfter,
    servedBeforeStatus: servedBefore.status,
    servedBeforeBytes: servedBefore.bytes,
    servedAfterStatus: servedAfter.status,
    servedAfterBytes: servedAfter.bytes,
  }
}

/** 故障注入收尾：把原始 tarball 拷回 storage，等同一 URL 重新 200、字节哈希复原、版本文档不变。 */
export async function restoreCorruptedTarball(options: {
  registry: LocalRegistry
  fault: TarballCorruptionFault
  timeoutMs?: number
}): Promise<TarballCorruptionRestore> {
  const { registry, fault } = options
  await ensureDir(join(registry.verdaccio.storageDir, fault.packageName))
  await cp(fault.backupPath, fault.tarballPath)
  const deadline = Date.now() + (options.timeoutMs || 30000)
  let restoredStatus = 0
  while (Date.now() < deadline) {
    const probe = await get(fault.tarballUrl)
    if (probe.status === 200) {
      const current = await readFile(fault.tarballPath)
      const restoredSha256 = sha256Of(current)
      const metadataAfter = await fetchMetadata(registry.baseUrl, fault.packageName)
      return {
        restoredStatus: probe.status,
        restoredSha256,
        shaMatches: restoredSha256 === fault.sha256Before,
        versionDocUnchanged: versionDocJson(metadataAfter.body, fault.version) === fault.versionDocBefore,
      }
    }
    restoredStatus = probe.status
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 300))
  }
  return { restoredStatus, restoredSha256: '', shaMatches: false, versionDocUnchanged: false }
}

/** 读一份已落盘的 tarball 备份的字节数（证据复核用）。 */
export async function backupSizeOf(fault: TarballFault): Promise<number> {
  try {
    return (await stat(fault.backupPath)).size
  } catch (error) {
    return -1
  }
}

/** 读备份 tarball 的前若干字节（人工复核用，不参与断言）。 */
export async function readBackupHead(fault: TarballFault, bytes = 16): Promise<string> {
  try {
    const data = await readFile(fault.backupPath)
    return Buffer.from(data).toString('hex').slice(0, bytes * 2)
  } catch (error) {
    return ''
  }
}
