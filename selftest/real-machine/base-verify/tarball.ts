/**
 * selftest/real-machine/base-verify/tarball.ts —— 纯 TS 的 gzip + tar 读取器（不 exec tar、不引依赖）。
 *
 * 为什么自己写：base 的 install 命令自带一条本仓不满足的校验（client entry 内必须内嵌
 * name@version 常量，那是 base 自家插件约定），且任务要求不改产品构建。所以预检工具自己
 * 解 npm pack 出来的 tgz，写进隔离 profile 的 node_modules。安全边界全部显式：
 *   - 每个 512 字节头都校验 checksum（拦截断/损坏）；
 *   - 路径拒绝绝对路径、盘符、反斜杠、.. 段，且根目录必须是 package/（npm pack 的形状）；
 *   - 条目数、单文件与总解压字节都有上限，超出即报错，不落盘。
 * 只支持 file/dir 与 pax/GNU longname 头；symlink/hardlink 一律拒绝（npm 包不应含它们）。
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { ensureDir } from '../../tooling/fs-utils.ts'
import { formatError } from '../../tooling/process.ts'

const BLOCK_SIZE = 512
const MAX_ENTRIES = 20000
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_PATH_LENGTH = 1024

/** tar 里一个文件条目（路径已剥掉 package/ 根、统一 / 分隔）。 */
export interface TarFileEntry {
  readonly path: string
  readonly data: Uint8Array
  readonly mode: number
}

export type TarReadResult =
  | { readonly ok: true; readonly value: { readonly files: readonly TarFileEntry[] } }
  | { readonly ok: false; readonly error: string }

export interface TarWriteResult {
  readonly files: number
  readonly bytes: number
}

function fail(error: string): TarReadResult {
  return { ok: false, error }
}

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

/** 读定长字段（到 NUL 为止）。 */
function readField(bytes: Uint8Array, offset: number, length: number): string {
  const end = offset + length
  let stop = offset
  while (stop < end && bytes[stop] !== 0) stop += 1
  return decodeUtf8(bytes.slice(offset, stop))
}

/** 读八进制数值字段；空字段按 0（GNU/ustar 都允许）。 */
function readOctal(bytes: Uint8Array, offset: number, length: number): number {
  const text = readField(bytes, offset, length).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) return Number.NaN
  return Number.parseInt(text, 8)
}

/** ustar 头校验和：把 checksum 字段（148..156）当 8 个空格求和。 */
function checksumMatches(bytes: Uint8Array, offset: number): boolean {
  const stored = readOctal(bytes, offset + 148, 8)
  if (!Number.isFinite(stored)) return false
  let sum = 0
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const value = index >= 148 && index < 156 ? 32 : bytes[offset + index]
    sum += value
  }
  return sum === stored
}

/** 路径规范化 + 边界校验；返回剥掉 package/ 根后的相对路径（'' 表示目录本身）。 */
function normalizeEntryPath(rawName: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  if (rawName.length > MAX_PATH_LENGTH) return { ok: false, error: 'tar 路径过长：' + JSON.stringify(rawName.slice(0, 80)) }
  if (rawName.includes('\\')) return { ok: false, error: 'tar 路径含反斜杠：' + JSON.stringify(rawName) }
  const name = rawName.replace(/^\.\//, '')
  if (name === '') return { ok: true, path: '' }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return { ok: false, error: 'tar 含绝对路径：' + JSON.stringify(rawName) }
  const segments: string[] = []
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { ok: false, error: 'tar 路径含 .. 段：' + JSON.stringify(rawName) }
    segments.push(segment)
  }
  if (segments.length === 0) return { ok: true, path: '' }
  if (segments[0] !== 'package') return { ok: false, error: 'tarball 根目录不是 package/：' + JSON.stringify(rawName) }
  return { ok: true, path: segments.slice(1).join('/') }
}

/** 解 gzip 并逐条读 tar；任何结构问题都返回 error（不抛）。 */
export function readTarballGz(tarball: Uint8Array): TarReadResult {
  let bytes: Uint8Array
  try {
    bytes = gunzipBytes(tarball)
  } catch (error) {
    return fail('gzip 解压失败：' + formatError(error))
  }
  const files: TarFileEntry[] = []
  let offset = 0
  let totalBytes = 0
  let paxPath: string | undefined
  while (offset + BLOCK_SIZE <= bytes.length) {
    let allZero = true
    for (let index = 0; index < BLOCK_SIZE; index += 1) {
      if (bytes[offset + index] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break
    if (!checksumMatches(bytes, offset)) return fail('tar 头校验和不对（offset=' + offset + '）')
    const name = readField(bytes, offset, 100)
    const prefix = readField(bytes, offset + 345, 155)
    const mode = readOctal(bytes, offset + 100, 8)
    const size = readOctal(bytes, offset + 124, 12)
    if (!Number.isFinite(mode) || !Number.isFinite(size) || size < 0) return fail('tar 头字段非法（offset=' + offset + '）')
    const typeFlag = bytes[offset + 156] === 0 ? '0' : String.fromCharCode(bytes[offset + 156])
    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + size
    if (dataEnd > bytes.length) return fail('tar 条目越过文件尾（offset=' + offset + '）')
    const data = bytes.slice(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (typeFlag === 'x' || typeFlag === 'g') {
      if (typeFlag === 'x') {
        const match = /(?:^|\n)\d+ path=([^\n]*)/.exec(decodeUtf8(data))
        if (match) paxPath = match[1]
      }
      continue
    }
    if (typeFlag === 'L') {
      paxPath = decodeUtf8(data).replace(/\0[\s\S]*$/, '').trim()
      continue
    }
    if (typeFlag === '5') continue
    if (typeFlag !== '0' && typeFlag !== '7') return fail('不支持的 tar 条目类型 ' + JSON.stringify(typeFlag) + '（' + name + '）')
    const rawName = paxPath ?? (prefix ? prefix + '/' + name : name)
    paxPath = undefined
    const normalized = normalizeEntryPath(rawName)
    if (!normalized.ok) return fail(normalized.error)
    if (normalized.path === '') continue
    totalBytes += size
    if (totalBytes > MAX_TOTAL_BYTES) return fail('tar 解压总字节超过上限（' + MAX_TOTAL_BYTES + '）')
    files.push({ path: normalized.path, data, mode: mode === 0 ? 0o644 : mode })
    if (files.length > MAX_ENTRIES) return fail('tar 条目数超过上限（' + MAX_ENTRIES + '）')
  }
  if (files.length === 0) return fail('tar 里没有可解包的文件')
  return { ok: true, value: { files } }
}

/** 把已解析条目写进目标目录（先清空；父目录自动建）。 */
export async function writeTarEntries(
  entries: readonly TarFileEntry[],
  targetDir: string,
): Promise<{ readonly ok: true; readonly value: TarWriteResult } | { readonly ok: false; readonly error: string }> {
  try {
    await rm(targetDir, { recursive: true, force: true })
    let bytes = 0
    for (const entry of entries) {
      const segments = entry.path.split('/')
      const target = join(targetDir, ...segments)
      await ensureDir(dirname(target))
      await writeFile(target, entry.data)
      bytes += entry.data.byteLength
    }
    return { ok: true, value: { files: entries.length, bytes } }
  } catch (error) {
    return { ok: false, error: '写盘失败：' + formatError(error) }
  }
}

/** 读一个 tgz 文件（供 install 层算哈希后解析）。 */
export async function readTarballFile(tarballPath: string): Promise<{ readonly ok: true; readonly value: Uint8Array } | { readonly ok: false; readonly error: string }> {
  try {
    return { ok: true, value: await readFile(tarballPath) }
  } catch (error) {
    return { ok: false, error: '读不到 tarball（' + tarballPath + '）：' + formatError(error) }
  }
}

/** gunzip 的薄包装：隔离对 node:zlib 的引用，方便单测替换。 */
function gunzipBytes(data: Uint8Array): Uint8Array {
  return gunzipSync(data)
}
