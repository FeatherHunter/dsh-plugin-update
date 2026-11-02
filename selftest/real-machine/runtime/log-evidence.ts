/**
 * selftest/real-machine/runtime/log-evidence.ts —— 产品日志证据（递归读 <home>/logs/**）。
 *
 * 为什么单独一层：T2 起日志按插件分子目录落盘（<home>/logs/<pluginId>/<date>.log），
 * 只读顶层会静默漏掉 update.install.exec 这类关键行；本文件把「递归读 + 逐行解析 + 整份拷 raw」
 * 收成一份实现，三个出口场景共用。
 *
 * 纪律：读之前先停宿主（或等日志冲刷），否则缓冲里的行可能还没落盘——拿不到就如实记 unknown，
 * 不拿别的 run 的行来补。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EvidenceRecorder } from './evidence.ts'
import { listFilesRecursive } from '../../tooling/fs-utils.ts'

/** 一行产品日志（JSON lines；解析失败的行走 notes，不静默吞）。 */
export interface LogEventRecord {
  readonly event: string
  readonly level: string | null
  readonly fields: Record<string, unknown>
  /** 相对 <home>/logs 的文件路径（POSIX 分隔符）。 */
  readonly source: string
  /** 文件内行号（1 起）。 */
  readonly line: number
}

/** 一次日志快照：事件 + 读过的文件 + 解析失败行数。 */
export interface LogSnapshot {
  readonly events: LogEventRecord[]
  readonly files: string[]
  readonly unparsedLines: number
}

/** 递归读 <home>/logs 下所有文件并解析 JSON lines（目录不存在时返回空快照）。 */
export async function readLogEvents(homeDir: string): Promise<LogSnapshot> {
  const logsDir = join(homeDir, 'logs')
  let files: string[] = []
  try {
    files = await listFilesRecursive(logsDir)
  } catch (error) {
    return { events: [], files: [], unparsedLines: 0 }
  }
  const events: LogEventRecord[] = []
  let unparsedLines = 0
  for (const relative of files) {
    let text = ''
    try {
      text = await readFile(join(logsDir, relative), 'utf8')
    } catch (error) {
      unparsedLines += 1
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        const event = typeof parsed['event'] === 'string' ? (parsed['event'] as string) : ''
        if (!event) {
          unparsedLines += 1
          continue
        }
        const fields = parsed['fields'] && typeof parsed['fields'] === 'object' ? (parsed['fields'] as Record<string, unknown>) : {}
        events.push({
          event,
          level: typeof parsed['level'] === 'string' ? (parsed['level'] as string) : null,
          fields,
          source: relative,
          line: index + 1,
        })
      } catch (error) {
        unparsedLines += 1
      }
    }
  }
  return { events, files, unparsedLines }
}

/** 取某个事件名的全部行（按落盘顺序）。 */
export function eventsOf(events: readonly LogEventRecord[], name: string): LogEventRecord[] {
  return events.filter((item) => item.event === name)
}

/** 取第一条匹配事件的字段值（没有返回 undefined）。 */
export function firstFieldOf(events: readonly LogEventRecord[], name: string, field: string): unknown {
  for (const item of events) {
    if (item.event !== name) continue
    if (Object.prototype.hasOwnProperty.call(item.fields, field)) return item.fields[field]
  }
  return undefined
}

/** 单份 raw 日志保留的最大字符数；超出时另存尾段，保证评审能看到收尾阶段的行。 */
const LOG_CONTENT_LIMIT = 50000
/** 截断时尾段保留的行数。 */
const LOG_TAIL_LINES = 200

/** UTF-8 字节数（不依赖 Buffer：tooling tsconfig 的 lib 里没有 Node 类型）。 */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const character of text) {
    const code = character.codePointAt(0)
    if (code === undefined) continue
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 一份被截断的日志：原始字节数、保留前多少字符、尾段 raw 路径。 */
export interface LogTruncation {
  readonly source: string
  readonly bytes: number
  readonly characters: number
  readonly keptCharacters: number
  readonly tailFile: string
}

/** 日志快照 + raw 文件清单 + 截断说明（供 run.json/index.md 标注「原始多大、截断到多少」）。 */
export interface LogCapture {
  readonly snapshot: LogSnapshot
  readonly rawFiles: string[]
  readonly truncations: LogTruncation[]
}

/**
 * 把 <home>/logs 下每个文件整份拷成 raw 证据。
 *
 * 超过 LOG_CONTENT_LIMIT 时除截断版外再落一份尾段 raw（最后 LOG_TAIL_LINES 行）：
 * T4 D4 实测成功尾段（exec/verify）正好落在 50000 字符之后，只截头会丢掉收尾证据。
 * 截断版与尾段都记原始字节数/字符数/保留量，评审可核对没被静默改写。
 */
export async function captureLogFiles(recorder: EvidenceRecorder, homeDir: string): Promise<LogCapture> {
  const snapshot = await readLogEvents(homeDir)
  const logsDir = join(homeDir, 'logs')
  const rawFiles: string[] = []
  const truncations: LogTruncation[] = []
  for (const relative of snapshot.files) {
    let content = ''
    try {
      content = await readFile(join(logsDir, relative), 'utf8')
    } catch (error) {
      content = '[读不到] ' + String((error as Error).message)
    }
    const source = join(logsDir, relative)
    const characters = content.length
    const bytes = utf8ByteLength(content)
    const truncated = characters > LOG_CONTENT_LIMIT
    const baseName = 'log-' + relative.replace(/[\\/]/g, '-').replace(/\.log$/, '')
    const file = await recorder.raw(baseName, {
      source,
      bytes,
      characters,
      truncated,
      keptCharacters: truncated ? LOG_CONTENT_LIMIT : characters,
      tailFile: truncated ? '见本日志的 -tail raw（最后 ' + String(LOG_TAIL_LINES) + ' 行）' : null,
      content: truncated ? content.slice(0, LOG_CONTENT_LIMIT) : content,
    })
    rawFiles.push(file)
    if (truncated) {
      const lines = content.split(/\r?\n/)
      const tailContent = lines.slice(-LOG_TAIL_LINES).join('\n')
      const tailFile = await recorder.raw(baseName + '-tail', {
        source,
        bytes,
        characters,
        totalLines: lines.length,
        tailLines: LOG_TAIL_LINES,
        tailStartLine: Math.max(1, lines.length - LOG_TAIL_LINES + 1),
        truncatedTo: LOG_CONTENT_LIMIT,
        content: tailContent,
      })
      rawFiles.push(tailFile)
      truncations.push({ source, bytes, characters, keptCharacters: LOG_CONTENT_LIMIT, tailFile })
    }
  }
  return { snapshot, rawFiles, truncations }
}
