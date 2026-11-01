/**
 * selftest/tooling/fs-utils.ts —— 工具层共用的文件/哈希原语。
 *
 * 证据里所有「内容一致」的判断都靠这里：单文件 sha256、整目录聚合指纹、JSON 落盘与读取。
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

/** 一段文本/字节的 sha256（hex）。 */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 文件内容的 sha256（读不到就抛，不吞错）。 */
export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path))
}

/** 目录树里的文件相对路径（递归、POSIX 分隔符、排序）。 */
export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) out.push(relative(root, absolute).split('\\').join('/'))
    }
  }
  await walk(root)
  return out.sort()
}

/** 整目录聚合指纹：每条「相对路径 + 文件哈希」按序拼再 sha256；目录内容一点变动都会换指纹。 */
export async function directoryFingerprint(root: string): Promise<{ files: number; digest: string; entries: { path: string; sha256: string }[] }> {
  const files = await listFilesRecursive(root)
  const entries: { path: string; sha256: string }[] = []
  for (const file of files) entries.push({ path: file, sha256: await sha256File(join(root, file)) })
  const digest = sha256(entries.map((entry) => entry.path + ':' + entry.sha256).join('\n'))
  return { files: entries.length, digest, entries }
}

/** 文件存在且是文件。 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch (error) {
    return false
  }
}

/** 目录存在且是目录。 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch (error) {
    return false
  }
}

/** 建目录（递归）。 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/** 写 JSON（自动建父目录；末尾换行，方便人读 diff）。 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

/** 读 JSON（读不到/解析失败都抛，不静默降级）。 */
export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}
