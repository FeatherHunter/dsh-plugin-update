// src/host/hub/handoff.ts —— 协议换代交接（#254）：注册表 Symbol 的换代约定 + 旧一代只读探针。
//
// 第一性：DSH 的 HMR 会在同一个宿主进程里把包版本换掉。globalThis 是共用的，模块实例各是各的；
// 旧一代的任务表与等待者只能由旧泵结算，新一代既不能覆盖它，也不能往里塞任务（否则旧等待者永远悬挂）。
// 所以注册表的 Symbol 键里带协议版本：两代各用各的槽，谁都不碰对方的表。
//
// 本模块只读旧 Symbol 上的形状，绝不写、不删；认不出的形状一律当没有。

import { HUB_PROTOCOL_VERSION } from './protocol.js'

/** 本代（以及未来任何一代）注册表挂在哪个 Symbol 上：键里带协议版本，换代即换键。 */
export function registrySymbolFor(version: number): symbol {
  return Symbol.for('dsh-plugin-update:update-hub:registry:v' + String(version))
}

/** 本代注册表的 Symbol。 */
export const HUB_REGISTRY_KEY: symbol = registrySymbolFor(HUB_PROTOCOL_VERSION)

interface LegacyHubRegistry {
  /** 旧一代状态对象上的协议版本（按它过滤，形状不对的一律当没有）。 */
  version: number
  /** 旧一代挂在 globalThis 上的 Symbol。 */
  key: symbol
}

/**
 * 认得的旧一代清单：一条记录同时给出「挂在哪个 Symbol」与「对象上的协议版本」——
 * 换代时只加一条，不会出现「两个平行数组各改一半」的漏改（#254 审查）。
 *
 * v1 = 未发布的中枢初版：当时键没有版本后缀。0.18.39 本身没有中枢，但那一格也不会被别的代码占用。
 */
const LEGACY_HUB_REGISTRIES: readonly LegacyHubRegistry[] = [
  { version: 1, key: Symbol.for('dsh-plugin-update:update-hub:registry') },
]

interface LegacyHubSlotShape {
  tasks?: Array<{ state?: string } | null> | null
}

interface LegacyHubStateShape {
  version?: number
  slots?: unknown
}

/** 旧一代的状态（只读）：防形读，认不出的形状一律当没有。 */
function legacyHubStates(): LegacyHubStateShape[] {
  const holder = globalThis as unknown as Record<PropertyKey, unknown>
  const found: LegacyHubStateShape[] = []
  for (const legacy of LEGACY_HUB_REGISTRIES) {
    try {
      const state = holder[legacy.key] as LegacyHubStateShape | undefined
      if (!state || typeof state !== 'object') continue
      if (state.version !== legacy.version) continue
      if (!(state.slots instanceof Map)) continue
      found.push(state)
    } catch {
      // 旧 Symbol 上的形状不受本代控制：读坏当没有。
    }
  }
  return found
}

function legacySlotBusy(slot: unknown): boolean {
  const tasks = (slot as LegacyHubSlotShape | undefined)?.tasks
  if (!Array.isArray(tasks)) return false
  return tasks.some((task) => Boolean(task) && typeof task === 'object' && (task as { state?: string }).state !== 'settled')
}

/** 按槽位键查旧一代是否还有未结算任务（只观察，绝不改旧任务表）。 */
export function legacyHubBusyForKey(key: string): boolean {
  try {
    return legacyHubStates().some((state) => legacySlotBusy((state.slots as Map<string, unknown>).get(key)))
  } catch {
    return false
  }
}
