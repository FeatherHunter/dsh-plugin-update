// src/panel/skip-store.ts —— 面板本地的跳过读写承诺（localStorage 优先，无环境退内存；写坏吞掉不挡更新）。
//
// 从 src/panel.ts 拆出（#226，蓝图 §4：panel/skip-store）。PanelSkipStore 类型按蓝图随实现
// 搬到这里（§4：旧 L348 的公开类型 + L398–522 的实现同住 skip-store），入口壳只做转出。

import { validReleaseVersion } from '../core/service.js'

/** 面板本地的跳过读写承诺：按版本记、可重置（宿主侧 skipped.json 是另一套落盘，互不干扰）。 */
export interface PanelSkipStore {
  list(): string[]
  has(version: string): boolean
  skip(version: string): void
  reset(version?: string): void
}

// ---------- 跳过存储（面板本地：localStorage 优先，无环境退内存；写坏吞掉不挡更新） ----------

const PANEL_SKIPPED_MAX = 50

function panelSkipKey(pluginId: string): string {
  return `dsh-upd-skipped/${String(pluginId)}`
}

function normalizePanelSkipped(raw: unknown): { version: string; skippedAt: number }[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { skipped?: unknown }).skipped
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: { version: string; skippedAt: number }[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const version = (item as { version?: unknown }).version
    if (!validReleaseVersion(version) || seen.has(version as string)) continue
    seen.add(version as string)
    const at = (item as { skippedAt?: unknown }).skippedAt
    out.push({ version: version as string, skippedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 })
  }
  return out.slice(0, PANEL_SKIPPED_MAX)
}

export function createMemorySkipStore(now: () => number = Date.now): PanelSkipStore {
  let skipped: { version: string; skippedAt: number }[] = []
  function assertVersion(version: unknown): string {
    if (!validReleaseVersion(version)) {
      throw new Error(`[dsh-plugin-update] 跳过版本号非法：须为发行版本号（收到 ${JSON.stringify(version)}）`)
    }
    return version as string
  }
  return {
    list: () => skipped.map((e) => e.version),
    has: (version) => (validReleaseVersion(version) ? skipped.some((e) => e.version === version) : false),
    skip: (version) => {
      const v = assertVersion(version)
      const at = now()
      skipped = [{ version: v, skippedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 }]
        .concat(skipped.filter((e) => e.version !== v))
        .slice(0, PANEL_SKIPPED_MAX)
    },
    reset: (version) => {
      if (version === undefined) skipped = []
      else skipped = skipped.filter((e) => e.version !== version)
    },
  }
}

interface PanelStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function probeStorage(candidate: unknown): PanelStorageLike | null {
  try {
    if (!candidate || typeof candidate !== 'object') return null
    const s = candidate as PanelStorageLike
    if (typeof s.getItem !== 'function' || typeof s.setItem !== 'function' || typeof s.removeItem !== 'function') return null
    return s
  } catch {
    return null
  }
}

/** 浏览器跳过存储（localStorage 形状即可；没有或写坏退内存，绝不因跳过挡住更新）。 */
export function createBrowserSkipStore(
  pluginId: string,
  storage?: unknown,
  now: () => number = Date.now,
): PanelSkipStore {
  const memory = createMemorySkipStore(now)
  const store =
    probeStorage(storage) ??
    probeStorage((globalThis as Record<string, unknown>)['localStorage'] ?? null) ??
    null
  if (!store) return memory
  const active: PanelStorageLike = store
  const key = panelSkipKey(pluginId)
  function read(): { version: string; skippedAt: number }[] {
    try {
      const raw = active.getItem(key)
      if (!raw) return []
      return normalizePanelSkipped(JSON.parse(raw))
    } catch {
      return []
    }
  }
  function write(entries: { version: string; skippedAt: number }[]): void {
    try {
      active.setItem(key, JSON.stringify({ skipped: entries }))
    } catch {
      // best-effort：跳过写不进去也不能挡更新。
    }
  }
  // 启动时把能读到的搬进内存镜像，之后走同一套语义。
  try {
    for (const e of read()) memory.skip(e.version)
  } catch {
    // 读坏自愈为空。
  }
  return {
    list: () => memory.list(),
    has: (version) => memory.has(version),
    skip: (version) => {
      memory.skip(version)
      write(normalizePanelSkipped({ skipped: memory.list().map((v) => ({ version: v, skippedAt: now() })) }))
    },
    reset: (version) => {
      memory.reset(version)
      if (version === undefined) {
        try {
          active.removeItem(key)
        } catch {
          // 删不掉也不挡更新。
        }
      } else {
        write(normalizePanelSkipped({ skipped: memory.list().map((v) => ({ version: v, skippedAt: now() })) }))
      }
    },
  }
}
