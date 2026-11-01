// src/host/hub/json-file.ts —— 中枢落盘的原子 JSON 读写（仅宿主侧）。
//
// 第一性：中枢的交接凭证（方案/租约）必须「要么旧、要么新」，绝不能读到写了一半的 JSON；
// 同时任何一次读写失败都只是「这次没交接成」，而不是「更新不能装」——所以这里只抛给调用方，
// 由各 store 自己决定降级（读坏 → 当没有；写坏 → 如实返回 false）。
//
// #276：光有「临时文件 + rename」还不够——rename 顶替是无条件覆盖，两个进程同抢时会「后写者赢」，
// 谁都不算错。租约是「同一时刻只有一个驾驶位」的唯一事实，所以这里再提供独占创建
// （createJsonFileExclusive）：目标已存在即失败，让调用方按 CAS 口径重读/让位。

import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
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

function tmpNameOf(file: string): string {
  tmpCounter += 1
  return `${file}.${process.pid}.${tmpCounter}.tmp`
}

/**
 * 原子整写一份 JSON：先写同目录临时文件（wx = 目标已存在即失败，绝不覆盖别人的进行中写），
 * 再 rename 顶替。失败抛给调用方（store 决定降级口径）；临时文件尽力清掉，不留垃圾。
 */
export async function writeJsonFileAtomic(file: string, value: unknown): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const tmp = tmpNameOf(file)
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

/** link 在目标已存在之外、还可能因为「这个文件系统根本不支持硬链接」失败；只有这些才允许退化直写。 */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])

/**
 * 独占发布一份 JSON（CAS 的「目标必须不存在」一侧）：成功 true；目标已存在 false；其它错误照抛。
 *
 * 实现：先把整份内容写进同目录临时文件，再用 link 发布——link 在目标已存在时以 EEXIST 失败，
 * 所以目标永远只会是某一方写完整的整份文件，不会出现半份 JSON（writeFile flag:'wx' 的直写
 * 在极端崩溃下会留下写了一半的目标文件）。文件系统不支持硬链接时（EPERM/EXDEV/ENOSYS...）
 * 退化为 writeFile flag:'wx' 独占写：语义一样，只是少了「目标永远完整」这层保护。
 */
export async function createJsonFileExclusive(file: string, value: unknown): Promise<boolean> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const body = JSON.stringify(value)
  const tmp = tmpNameOf(file)
  try {
    await writeFile(tmp, body, { mode: 0o600, flag: 'wx' })
    try {
      await link(tmp, file)
      return true
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'EEXIST') return false
      // 只有「文件系统不支持硬链接」这几种错才退化；磁盘满/只读等真错误照抛，不许静默降级。
      if (code !== undefined && !LINK_UNSUPPORTED_CODES.has(code)) throw error
      try {
        await writeFile(file, body, { mode: 0o600, flag: 'wx' })
        return true
      } catch (fallbackError) {
        if ((fallbackError as { code?: string } | null)?.code === 'EEXIST') return false
        throw fallbackError
      }
    }
  } finally {
    try {
      await unlink(tmp)
    } catch {}
  }
}
