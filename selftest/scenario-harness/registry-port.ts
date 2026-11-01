/**
 * selftest/scenario-harness/registry-port.ts —— “新版从哪查”端口（Strategy）。
 *
 * 对照本包内核：`src/core/fetch.ts` 负责联网查 registry；这里的端口把它抽象掉，
 * 让 B 档（本地目录）与 C 档（真 npm）可互换，场景代码只认端口、不认实现。
 *
 * 数据结构：版本表是只读记录 `Readonly<Record<targetName, latestVersion>>`（JSON 友好，
 * 可直接落盘对账）；结果是 `string | null`（查不到 = null，不抛，由 runner 判失败）。
 */

export interface RegistryPort {
  /** 策略名：`local-directory`（B 档）/ `npm`（C 档未来）；只进日志与断言，不参与决策。 */
  readonly kind: string
  resolveLatest(targetName: string): Promise<string | null>
}

/** B 档：本地版本表（harness 预置 `0.0.1 → 0.0.2`，不联网、不读盘，确定性最高）。 */
export function createLocalDirectoryRegistry(
  latestByTarget: Readonly<Record<string, string>>,
): RegistryPort {
  const table: Readonly<Record<string, string>> = { ...latestByTarget }
  return {
    kind: 'local-directory',
    async resolveLatest(targetName: string): Promise<string | null> {
      const hit = table[targetName]
      return typeof hit === 'string' && hit.length > 0 ? hit : null
    },
  }
}

/**
 * C 档占位：真 npm registry（本档不实现）。
 * 故意返回 rejected promise 而不是 null——“没接线”与“查了但没有”是两种事实，
 * 前者必须炸（早失败），后者才判场景失败（见 runner）。
 */
export function createNpmRegistryPlaceholder(): RegistryPort {
  return {
    kind: 'npm',
    async resolveLatest(): Promise<string | null> {
      throw new Error('[selftest] npm registry not wired in B (see README: C 档才接真源)')
    },
  }
}
