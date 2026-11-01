/**
 * selftest/scenario-harness/update-verdict.ts —— “装上没、串没串”裁决（纯函数）。
 *
 * 对照内核：该不该升由 `src/core/service.ts` 判（本文件不碰）；
 * 这里只判两条可观测事实：
 * 1. 单目标：装后版 == 要的版（`compareVersions` 仅限 `0.0.x` 骨架；真 semver 在 C 档换核心实现）。
 * 2. 批量：两家的调用记录互不相交、每家恰好一次（隔离性；顺序按 TARGET_PAIR 固定）。
 *
 * 数据结构：`UpdateVerdict` 是判别联合（ exhaustive switch 由 tsc 兜底缺分支）。
 */

export type UpdateVerdict =
  | { readonly kind: 'updated'; readonly installedVersion: string }
  | { readonly kind: 'already-latest'; readonly installedVersion: string }
  | { readonly kind: 'mismatch'; readonly installedVersion: string; readonly expectedVersion: string }
  | { readonly kind: 'install-failed'; readonly spec: string; readonly exitCode: number }

function parseTriple(version: string): readonly [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 纯：三段式比较（骨架 scope：`0.0.x`；非法输入返回 null，不猜）。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseTriple(a)
  const pb = parseTriple(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

/** 纯：单目标裁决（exitCode 非 0 直接判安装失败，不再比版本）。 */
export function verifySingleTargetUpdated(args: {
  readonly installedVersion: string
  readonly expectedVersion: string
  readonly exitCode: number
  readonly spec: string
}): UpdateVerdict {
  if (args.exitCode !== 0) {
    return { kind: 'install-failed', spec: args.spec, exitCode: args.exitCode }
  }
  const cmp = compareVersions(args.installedVersion, args.expectedVersion)
  if (cmp === null) {
    return { kind: 'mismatch', installedVersion: args.installedVersion, expectedVersion: args.expectedVersion }
  }
  if (cmp === 0) return { kind: 'updated', installedVersion: args.installedVersion }
  return { kind: 'mismatch', installedVersion: args.installedVersion, expectedVersion: args.expectedVersion }
}

/**
 * 纯：批量隔离裁决——每家恰好一次、互不相交。
 * 输入是“各家看到的装后版”；调用记录的断言在 runner 侧（见 scenario-runner）。
 */
export function verifyBatchIsolation(args: {
  readonly installedByTarget: Readonly<Record<string, string>>
  readonly expectedByTarget: Readonly<Record<string, string>>
}): UpdateVerdict {
  const names = Object.keys(args.expectedByTarget).sort()
  for (const name of names) {
    const installed = args.installedByTarget[name]
    const expected = args.expectedByTarget[name]
    if (typeof installed !== 'string' || typeof expected !== 'string') {
      return { kind: 'mismatch', installedVersion: String(installed ?? ''), expectedVersion: String(expected ?? '') }
    }
    const cmp = compareVersions(installed, expected)
    if (cmp !== 0) {
      return { kind: 'mismatch', installedVersion: installed, expectedVersion: expected }
    }
  }
  return { kind: 'updated', installedVersion: names.map((n) => `${n}@${args.installedByTarget[n]}`).join(',') }
}
