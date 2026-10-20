/**
 * src/shared/version.ts —— 运行版本的归一（#182/#216/#241）。
 *
 * 集成方拿不到宿主半区的运行版本时，历史上会注入占位版号 `0.0.0`（#216 只在显示层挡过）。
 * 占位不是任何真实发行版：读取器与核心都必须按「未知」处理，否则 `0.0.0 !== 盘上版`
 * 会伪造出 `pending-restart`/`recovery-required` 并挡住恢复性重试（#241 真机现场）。
 */

/** 集成方给未知运行版填的占位版号：`0.0.0` 不是任何一版的真版本。 */
export const PLACEHOLDER_RUNNING_VERSION = '0.0.0'

/** 运行版本归一：非字符串/空串/占位版号一律 `null`（未知是一等状态，绝不伪造）。 */
export function normalizeRunningVersion(value: unknown): string | null {
  const trimmed = typeof value === 'string' && value.trim() ? value.trim() : null
  return trimmed === PLACEHOLDER_RUNNING_VERSION ? null : trimmed
}
