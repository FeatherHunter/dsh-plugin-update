/**
 * 更新器自检（#196 部署偏斜）：回答「此刻跑的这一份 dsh-plugin-update 是谁、哪版、套在哪一层」。
 *
 * 为什么需要：同一个 DSH 里可以同时住着好几代本包——使用范围级一份（hoisted），
 * 消费方插件各自 node_modules 里还可能有各自嵌套的一份（声明范围钉死在旧 minor 时永远拿不到新版本）。
 * 修好的是哪一份、坏的是哪一份，光看面板/报错分不出来；这里按 `import.meta.url` 反查
 * **当前加载到的这份副本**自己的 package.json，给出可对账的事实（版本 + 副本层级 + 目录）。
 *
 * 口径：
 * - 只读本副本自身（不猜别处、不联网、不读 profile）；拿不准就回 null / 'unknown'，绝不编版本号；
 * - 层级判据只看包根路径里的 `/node_modules/` 段数：0=开发仓库，1=使用范围级，≥2=嵌套副本；
 * - 目录只给宿主侧诊断/环境视图用，公开电话（env）只转发版本与层级，不回本机路径。
 */
import { fileURLToPath } from 'node:url'

import { containingPackage } from './reader.js'

const PACKAGE_NAME = 'dsh-plugin-update'

/** 这份副本住在哪一层（部署偏斜的核心事实）。 */
export type SelfCopyLevel = 'profile' | 'nested' | 'repo' | 'unknown'

export interface SelfCopyInfo {
  /** 本副本 package.json 的版本；读不到为 null（不编造）。 */
  version: string | null
  /** 本副本的包根目录；反查不到为 null。 */
  directory: string | null
  /** 副本层级：使用范围级 / 嵌套 / 开发仓库 / 未知。 */
  level: SelfCopyLevel
}

/**
 * 纯判据：包根路径里的 `/node_modules/` 段数 → 副本层级。
 * `D:/p/node_modules/dsh-plugin-update` → profile；
 * `D:/p/node_modules/consumer/node_modules/dsh-plugin-update` → nested；
 * 没有任何 node_modules 段的路径（仓库里跑）→ repo；空/读不到 → unknown。
 */
export function selfCopyLevelOf(directory: string | null | undefined): SelfCopyLevel {
  const normalized = String(directory ?? '').replace(/\\/g, '/')
  if (!normalized) return 'unknown'
  const hits = normalized.split('/node_modules/').length - 1
  if (hits === 0) return normalized.includes('/') ? 'repo' : 'unknown'
  return hits === 1 ? 'profile' : 'nested'
}

/**
 * 反查「这份副本」：从模块地址（缺省 `import.meta.url`，即调用方所在模块）向上找到
 * 名字对得上的 package.json，读出该副本自己的版本与包根；任何一步失败都按未知返回。
 * 参数留 moduleUrl 覆盖口，供测试指向临时假副本。
 */
export async function selfCopyInfo(moduleUrl: string = import.meta.url): Promise<SelfCopyInfo> {
  let filename: string
  try {
    filename = fileURLToPath(moduleUrl)
  } catch {
    return { version: null, directory: null, level: 'unknown' }
  }
  try {
    const found = await containingPackage(filename, PACKAGE_NAME)
    if (!found) return { version: null, directory: null, level: 'unknown' }
    const raw = found.manifest.version
    const version = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    return { version, directory: found.directory, level: selfCopyLevelOf(found.directory) }
  } catch {
    return { version: null, directory: null, level: 'unknown' }
  }
}
