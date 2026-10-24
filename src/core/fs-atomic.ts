// src/core/fs-atomic.ts —— 原子落盘的共享底座（宿主侧）。
//
// 第一性：本包所有的「整份替换」都先写同目录临时文件、再 rename 顶替。
// 但 Windows 上 rename 顶替是尽力而为的：目标文件恰好被扫描器/别的句柄短暂占用时，
// MoveFileEx 会返回 EPERM/EACCES/EBUSY。这不是数据错误，是一次「稍后重试就好」的
// 瞬时失败——当成永久失败会把「账本写不进去」误报成安装失败（batch-unavailable）。
// 所以集中在这里重试几次；调用方仍只看到「成功 / 抛错」，原子性与错误口径不变。

import { rename } from 'node:fs/promises'

/** 瞬时错误最多试几次（含第一次）。 */
export const RENAME_RETRY_ATTEMPTS = 5
/** 退避基数：第 n 次失败后等 BASE_MS * n（Windows 上扫描器通常几十毫秒内放手）。 */
const RENAME_RETRY_BASE_MS = 20
const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * rename 顶替的瞬时错误重试。
 * - 非瞬时错误（ENOENT、ENOSPC、只读目录……）立即抛出，不掩盖真问题；
 * - 重试用尽仍失败就抛原错误（错误码保留，调用方仍能按 code 分类）。
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as { code?: string } | null)?.code
      const retryable = typeof code === 'string' && RETRYABLE_CODES.has(code)
      if (!retryable || attempt === RENAME_RETRY_ATTEMPTS) break
      await sleep(RENAME_RETRY_BASE_MS * attempt)
    }
  }
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const setTimer = (globalThis as unknown as { setTimeout?: (callback: () => void, ms: number) => unknown })
      .setTimeout
    if (typeof setTimer !== 'function') {
      resolve()
      return
    }
    setTimer(resolve, ms)
  })
}
