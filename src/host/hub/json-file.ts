// src/host/hub/json-file.ts —— 中枢落盘的原子 JSON 读写（仅宿主侧）。
//
// 第一性：中枢的交接凭证（方案/租约）必须「要么旧、要么新」，绝不能读到写了一半的 JSON；
// 同时任何一次读写失败都只是「这次没交接成」，而不是「更新不能装」——所以这里只抛给调用方，
// 由各 store 自己决定降级（读坏 → 当没有；写坏 → 如实返回 false）。

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { renameWithRetry } from '../../core/fs-atomic.js'
import { dirname } from 'node:path'

/** 读一份 JSON；文件不存在/超限/坏 JSON 一律 null（自愈，不抛）。 */
export async function readJsonFile(file: string, maxBytes: number): Promise<unknown> {
  try {
    // 预算按字符数近似（方案/租约都是 ASCII 为主；多留一点余量，不为此引入 Buffer 读）。
    const text = await readFile(file, 'utf8')
    if (text.length === 0 || text.length > maxBytes) return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

let tmpCounter = 0

/**
 * 原子整写一份 JSON：先写同目录临时文件（wx = 目标已存在即失败，绝不覆盖别人的进行中写），
 * 再 rename 顶替。失败抛给调用方（store 决定降级口径）；临时文件尽力清掉，不留垃圾。
 */
export async function writeJsonFileAtomic(file: string, value: unknown): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  tmpCounter += 1
  const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await renameWithRetry(tmp, file)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {}
    throw error
  }
}

