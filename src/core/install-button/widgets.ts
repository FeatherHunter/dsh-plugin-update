/**
 * src/core/install-button/widgets.ts —— 安装按钮的本地小件（对象判定/HTML 转义/快照归一/请求 id/字节数/计时器/兜底文案，#221 自旧 src/install-button.ts 拆出）。
 *
 * 与 panel 同形（见各函数 parity 注释）；判定一律调 panel 纯函数。跨文件被 render/mount 复用，
 * 故各函数统一 export；不属于公开面（入口壳不转出）。
 */
import type { UpdateSnapshot } from '../../shared/ports.js'
import type { VisibleQueue } from '../../core/queue/model.js'

// ---------- 本地小件（与 panel 同形，见 parity 注释；判定一律调 panel 纯函数） ----------

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Parity with panel asSnapshot: invalid shape never replaces the live snapshot.
export function asSnapshot(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  if (typeof value['canInstall'] !== 'boolean') return null
  return value as unknown as UpdateSnapshot
}

// Parity with panel asQueue: queue view is best-effort, wrong shape ignored.
export function asQueue(value: unknown): VisibleQueue | null {
  if (!isObject(value) || typeof value['busy'] !== 'boolean') return null
  return value as unknown as VisibleQueue
}

// Parity with panel randomRequestId: fresh idempotency id per install click.
export function randomRequestId(): string {
  try {
    const rand = Math.floor(Math.random() * 0xffffff).toString(36)
    return `r${Date.now().toString(36)}${rand}`.slice(0, 64)
  } catch {
    return `r${Date.now()}`
  }
}

// Parity with panel jobTargetOf: install target of that failed run, null when unknown.
export function jobTargetOf(value: unknown): string | null {
  try {
    const job = (value as { job?: { targetVersion?: unknown } } | null | undefined)?.job
    const tv = job?.targetVersion
    return typeof tv === 'string' && tv.trim() ? tv.trim() : null
  } catch {
    return null
  }
}

export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

export function getTimer(): { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } {
  const g = globalThis as Record<string, unknown>
  const set = g['setInterval']
  const clear = g['clearInterval']
  if (typeof set === 'function' && typeof clear === 'function') {
    return {
      set: (fn, ms) => (set as (fn: () => void, ms: number) => unknown).call(g, fn, ms),
      clear: (handle) => (clear as (handle: unknown) => void).call(g, handle),
    }
  }
  return { set: () => null, clear: () => {} }
}

export async function defaultCopyText(text: string): Promise<void> {
  try {
    const holder = (globalThis as Record<string, unknown>)['navigator'] as
      | { clipboard?: { writeText?: (t: string) => Promise<void> } }
      | undefined
    const clip = holder?.clipboard
    const write = clip?.writeText
    if (clip && typeof write === 'function') {
      await write.call(clip, text)
      return
    }
  } catch {
    // Clipboard unavailable: caller shows the manual-select fallback, never throws.
  }
}
