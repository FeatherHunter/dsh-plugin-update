/**
 * src/changelog-io.ts —— 更新日志的 Node 侧读写（#23）。
 *
 * 纯解析在 `src/changelog.ts`（零导入，两边可进）；
 * 本文件只做跑腿（读盘、联网、解包、验 integrity），仅 Node 侧导入，
 * 面板（浏览器闭包）永不导入本文件。
 *
 * 两种读取时机（#11 §4 第 5 条）：
 * - 已装版离线读：`node_modules/<目标包>/CHANGELOG.md`（与版本 pin 绑定，零新增联网）；
 * - 新版按需取：新版 tarball 内同名文件，复用官方源 + integrity 校验；
 * 取不到一律回 null（调用方渲染中性提示，不挡安装、不写 blockedReason）。
 *
 * 记住策略（#41 终裁，三墙不动，只澄清注释）：成功与取不到（null）按版本永久记
 * （面板内存会话级 + 宿主进程级，不落盘，显式文本永不覆盖）；传输失败不进缓存，
 * 手动查新版/换版/重开面板立即重问，轮询按退避问（三处共用 shouldFetchChangelog，各存各的）。
 * 三墙（8MB 压缩态/32MB 解压后/64K 日志文本）一字不动，超限回 null 由调用方按取不到记住。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { CHANGELOG_FILENAME, CHANGELOG_MAX_CHARS } from './changelog.js'
import { INTEGRITY_PATTERN } from './service.js'

/** tarball 下载上限（字节，压缩态）：超限直接回落中性提示，不解包、不OOM。 */
export const CHANGELOG_TARBALL_MAX_BYTES = 8 * 1024 * 1024
/**
 * tar 解压后上限（字节）：gzip 炸弹墙（#23 对抗复查补记——此前只卡压缩态，
 * 恶意小包可炸出 GB 级 tar 直接 OOM 宿主）。超限回 null，调用方渲染中性提示。
 */
export const CHANGELOG_TAR_MAX_BYTES = 32 * 1024 * 1024
/** 日志文本上限（字节）：超限截断后返回，不断面板。 */
export const CHANGELOG_FETCH_MAX_BYTES = 64 * 1024
/** 默认官方源（与 service.NPM_REGISTRY 同值，显式传参优先）。 */
export const CHANGELOG_DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

function byteLengthOf(text: string): number {
  try {
    return Buffer.byteLength(text, 'utf8')
  } catch {
    return text.length
  }
}

function truncateToBytes(text: string, maxBytes: number): string {
  try {
    if (byteLengthOf(text) <= maxBytes) return text
    const buf = Buffer.from(text, 'utf8')
    return buf.slice(0, maxBytes).toString()
  } catch {
    return text.slice(0, Math.min(text.length, maxBytes))
  }
}

function timeoutSignal(ms: number): unknown {
  try {
    const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal
    if (ctor && typeof ctor.timeout === 'function') return ctor.timeout(ms)
  } catch {
    // 无超时能力即直接请求，外层仍可收敛为 null。
  }
  return undefined
}

/**
 * 已装版离线读（best-effort，失败回 null）：
 *读 `<目标包目录>/CHANGELOG.md`，空文件回 null（调用方给中性提示）。
 */
export async function readInstalledChangelogText(
  targetPackageDir: unknown,
  opts?: { maxBytes?: number },
): Promise<string | null> {
  try {
    const dir = typeof targetPackageDir === 'string' ? targetPackageDir.trim() : ''
    if (!dir) return null
    const maxBytes =
      opts && typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
        ? Math.floor(opts.maxBytes)
        : CHANGELOG_FETCH_MAX_BYTES
    let text: string
    try {
      text = await readFile(join(dir, CHANGELOG_FILENAME), 'utf8')
    } catch {
      return null
    }
    if (typeof text !== 'string' || !text.trim()) return null
    if (text.length > CHANGELOG_MAX_CHARS) text = text.slice(0, CHANGELOG_MAX_CHARS)
    if (byteLengthOf(text) > maxBytes) text = truncateToBytes(text, maxBytes)
    return text.trim() ? text : null
  } catch {
    return null
  }
}

export interface ReleaseChangelogRef {
  /** tarball 地址（service.fetchNpmRelease 回的 tarball 原样）。 */
  tarball: unknown
  /** integrity 串（`sha512-…`，复用官方源校验）。 */
  integrity: unknown
  /** 该发行版本号（用于严格路径校验，可选）。 */
  version?: unknown
}

async function readResponseBytes(response: unknown): Promise<Uint8Array | null> {
  try {
    const r = response as {
      arrayBuffer?: () => Promise<ArrayBuffer>
      bytes?: () => Promise<Uint8Array>
    }
    if (r && typeof r.arrayBuffer === 'function') {
      const ab = await r.arrayBuffer()
      if (ab instanceof ArrayBuffer) return new Uint8Array(ab)
      if (ab && typeof (ab as { byteLength?: unknown }).byteLength === 'number') {
        return new Uint8Array(ab as ArrayBuffer)
      }
      return null
    }
    if (r && typeof r.bytes === 'function') {
      const b = await r.bytes()
      if (b instanceof Uint8Array) return b
      return null
    }
    // 只有 text() 的 MinimalResponse 无法安全承载二进制 tarball：诚实回 null。
    return null
  } catch {
    return null
  }
}

function parseOctal(bytes: Uint8Array, offset: number, length: number): number {
  try {
    let s = ''
    for (let i = 0; i < length; i++) {
      const c = bytes[offset + i]
      if (c === 0 || c === 32) {
        if (s) break
        continue
      }
      s += String.fromCharCode(c)
      if (s.length > 12) break
    }
    s = s.trim()
    if (!/^[0-7]+$/.test(s)) return NaN
    return parseInt(s, 8)
  } catch {
    return NaN
  }
}

function readTarName(bytes: Uint8Array, offset: number): string {
  try {
    let end = offset
    while (end < offset + 100 && end < bytes.length && bytes[end] !== 0) end++
    const slice = bytes.slice(offset, end)
    try {
      return Buffer.from(slice).toString().trim()
    } catch {
      let s = ''
      for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i])
      return s.trim()
    }
  } catch {
    return ''
  }
}

function normalizeTarEntryName(raw: string): string {
  try {
    let n = String(raw || '').trim().replace(/\\/g, '/')
    n = n.replace(/^\.\//, '')
    n = n.replace(/^\/+/, '')
    return n
  } catch {
    return ''
  }
}

function isChangelogEntryName(normalized: string): boolean {
  try {
    if (!normalized) return false
    // 大小写敏感（与包内 `CHANGELOG.md` 同名口径；小写 `changelog.md` 等变体视为缺日志，
    // 回中性提示——对抗复查确认的已知边界，不静默放宽）。
    if (normalized === CHANGELOG_FILENAME) return true
    // npm 包内形如 `package/CHANGELOG.md`（顶层目录 + 同名文件）。
    if (normalized.endsWith(`/${CHANGELOG_FILENAME}`)) return true
    return false
  } catch {
    return false
  }
}

/**
 * 从已解压的 tar 包里取同名文件（best-effort，找不到回 null）。
 * 只收普通文件（typeflag `0`/`\0`），目录与特殊文件一律跳过。
 */
export function extractChangelogFromTar(tarBytes: Uint8Array, maxBytes = CHANGELOG_FETCH_MAX_BYTES): string | null {
  try {
    if (!tarBytes || tarBytes.length < 512 || tarBytes.length % 512 !== 0) {
      // 允许非 512 对齐的截断包？严格要求对齐，否则回 null（诚实失败）。
      if (!tarBytes || tarBytes.length < 512) return null
    }
    let offset = 0
    while (offset + 512 <= tarBytes.length) {
      // 空块（全零）即 tar 结尾。
      let allZero = true
      for (let i = 0; i < 512; i++) {
        if (tarBytes[offset + i] !== 0) {
          allZero = false
          break
        }
      }
      if (allZero) break
      const rawName = readTarName(tarBytes, offset)
      const name = normalizeTarEntryName(rawName)
      const size = parseOctal(tarBytes, offset + 124, 12)
      if (!Number.isFinite(size) || size < 0) return null
      const typeflag = String.fromCharCode(tarBytes[offset + 156] ?? 0)
      const dataStart = offset + 512
      const dataEnd = dataStart + size
      if (dataEnd > tarBytes.length) return null
      const isFile = typeflag === '0' || typeflag === '\0' || typeflag === ''
      if (isFile && isChangelogEntryName(name)) {
        const slice = tarBytes.slice(dataStart, dataEnd)
        let text = ''
        try {
          text = Buffer.from(slice).toString()
        } catch {
          return null
        }
        if (!text.trim()) return null
        if (text.length > CHANGELOG_MAX_CHARS) text = text.slice(0, CHANGELOG_MAX_CHARS)
        if (byteLengthOf(text) > maxBytes) text = truncateToBytes(text, maxBytes)
        return text.trim() ? text : null
      }
      // 数据区按 512 对齐跳过。
      const blocks = Math.ceil(size / 512)
      offset = dataStart + blocks * 512
      // 防死循环：offset 必须前进。
      if (blocks < 0) return null
    }
    return null
  } catch {
    return null
  }
}

function verifyIntegrity(bytes: Uint8Array, integrity: string): boolean {
  try {
    const m = String(integrity).match(/^sha512-([A-Za-z0-9+/]{86}==)$/)
    if (!m) return false
    const actual = createHash('sha512').update(Buffer.from(bytes)).digest('base64')
    return actual === m[1]
  } catch {
    return false
  }
}

/**
 * 新版按需取（best-effort，任何一步失败回 null，调用方渲染中性提示）：
 * 取 tarball → 验 integrity（官方源同一信任根）→ gunzip → 取包内同名文件。
 * 同源校验：tarball 与 registryUrl 同 origin、无用户信息、无 search/hash；
 * 有目标包名 + 版本时再要求精确路径（与 service.fetchNpmRelease 同形）。
 */
export async function fetchReleaseChangelogText(
  fetchImpl: unknown,
  release: ReleaseChangelogRef | null | undefined,
  opts?: {
    targetPackageName?: string
    registryUrl?: string
    timeoutMs?: number
    maxTarballBytes?: number
    maxChangelogBytes?: number
  },
): Promise<string | null> {
  try {
    if (typeof fetchImpl !== 'function') return null
    const tarballText = (release as { tarball?: unknown } | null)?.tarball
    const integrityText = (release as { integrity?: unknown } | null)?.integrity
    if (typeof tarballText !== 'string' || !tarballText) return null
    if (typeof integrityText !== 'string' || !new RegExp(INTEGRITY_PATTERN).test(integrityText)) return null
    const registryUrl =
      opts && typeof opts.registryUrl === 'string' && opts.registryUrl ? String(opts.registryUrl) : CHANGELOG_DEFAULT_REGISTRY
    let tarballUrl: URL
    let registryOrigin = ''
    try {
      tarballUrl = new URL(tarballText)
      registryOrigin = new URL(registryUrl).origin
    } catch {
      return null
    }
    if (tarballUrl.protocol !== 'https:') return null
    if (tarballUrl.origin !== registryOrigin) return null
    if (tarballUrl.username || tarballUrl.password || tarballUrl.search || tarballUrl.hash) return null
    if (!tarballUrl.pathname.endsWith('.tgz')) return null
    const targetName = opts && typeof opts.targetPackageName === 'string' ? String(opts.targetPackageName) : ''
    const versionText =
      release && typeof (release as { version?: unknown }).version === 'string'
        ? String((release as { version: string }).version)
        : ''
    if (targetName && versionText) {
      const expectPath = `/${targetName}/-/${targetName}-${versionText}.tgz`
      if (tarballUrl.pathname !== expectPath) return null
    }
    const timeoutMs =
      opts && typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? Math.floor(opts.timeoutMs)
        : 10_000
    const maxTarballBytes =
      opts && typeof opts.maxTarballBytes === 'number' && Number.isFinite(opts.maxTarballBytes) && opts.maxTarballBytes > 0
        ? Math.floor(opts.maxTarballBytes)
        : CHANGELOG_TARBALL_MAX_BYTES
    const maxChangelogBytes =
      opts && typeof opts.maxChangelogBytes === 'number' && Number.isFinite(opts.maxChangelogBytes) && opts.maxChangelogBytes > 0
        ? Math.floor(opts.maxChangelogBytes)
        : CHANGELOG_FETCH_MAX_BYTES
    let response: unknown = null
    try {
      response = await (fetchImpl as (url: string, init?: Record<string, unknown>) => Promise<unknown>)(tarballUrl.href, {
        headers: { accept: 'application/octet-stream' },
        redirect: 'error',
        signal: timeoutSignal(timeoutMs),
      })
    } catch {
      return null
    }
    const ok = (response as { ok?: unknown })?.ok
    if (ok !== true) return null
    try {
      const headers = (response as { headers?: { get?: (n: string) => string | null } }).headers
      const declared = headers && typeof headers.get === 'function' ? Number(headers.get('content-length')) : NaN
      if (Number.isFinite(declared) && declared > maxTarballBytes) return null
    } catch {
      // 头读不到即不拦，由字节数兜底。
    }
    const bytes = await readResponseBytes(response)
    if (!bytes || bytes.length === 0 || bytes.length > maxTarballBytes) return null
    if (!verifyIntegrity(bytes, integrityText)) return null
    let tar: Uint8Array
    try {
      const out = gunzipSync(Buffer.from(bytes))
      tar = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
    } catch {
      return null
    }
    if (tar.length === 0 || tar.length > CHANGELOG_TAR_MAX_BYTES) return null
    return extractChangelogFromTar(tar, maxChangelogBytes)
  } catch {
    return null
  }
}
