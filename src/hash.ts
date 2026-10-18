/**
 * src/hash.ts —— 短哈希的唯一实现（#207）。
 *
 * 日志行里不放原始 requestId/插件标识（ADR-0006：只放派生量），但「同一次意图」需要
 * 一个可比较的键：djb2 → 8 位十六进制，固定宽度、稳定、不可逆。它不是加密哈希，
 * 只用于聚合与去重；跨进程/跨版本保持同一算法。
 */
export function hash8(value: unknown): string {
  try {
    const text = String(value ?? '')
    let h = 5381
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
    return (`0000000${h.toString(16)}`).slice(-8)
  } catch {
    return '00000000'
  }
}
