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

/** 把 <home>/logs 下每个文件整份拷成 raw 证据（{source, content}，超长截断并注明）。 */
export async function captureLogFiles(recorder: EvidenceRecorder, homeDir: string): Promise<{ snapshot: LogSnapshot; rawFiles: string[] }> {
  const snapshot = await readLogEvents(homeDir)
  const logsDir = join(homeDir, 'logs')
  const rawFiles: string[] = []
  for (const relative of snapshot.files) {
    let content = ''
    try {
      content = await readFile(join(logsDir, relative), 'utf8')
    } catch (error) {
      content = '[读不到] ' + String((error as Error).message)
    }
    const truncated = content.length > 50000
    const file = await recorder.raw('log-' + relative.replace(/[\\/]/g, '-').replace(/\.log$/, ''), {
      source: join(logsDir, relative),
      content: truncated ? content.slice(0, 50000) : content,
      truncated,
    })
    rawFiles.push(file)
  }
  return { snapshot, rawFiles }
}
